import 'dart:io';

import 'command_runner.dart';
import 'flutter_toolchain.dart';
import 'locale_proposal_adapter.dart'
    show
        LocaleProposalArtifact,
        LocaleProposalGateway,
        PortugueseLocaleDelivery;
import 'staging_worktree.dart';

export 'command_runner.dart';
export 'flutter_toolchain.dart';

const _l10nDirectory = 'packages/brickit_generated/lib/l10n';
const _l10nConfigPath = 'packages/brickit_generated/l10n.yaml';

class ReleaseRecordIdentity {
  const ReleaseRecordIdentity({
    required this.id,
    required this.projectId,
    required this.baselineSnapshotId,
    required this.repository,
    required this.baselineCommit,
    required this.manifestHash,
    required this.integrationBranch,
  });

  final String id;
  final String projectId;
  final String baselineSnapshotId;
  final String repository;
  final String baselineCommit;
  final String manifestHash;
  final String integrationBranch;
}

class BoundCatalog {
  const BoundCatalog({
    required this.localeCode,
    required this.catalogPath,
    required this.isSource,
  });

  final String localeCode;
  final String catalogPath;
  final bool isSource;
}

class ReleaseSummary {
  const ReleaseSummary({
    required this.releaseRecord,
    required this.catalogs,
    required this.changeKeyCount,
  });

  final ReleaseRecordIdentity releaseRecord;
  final List<BoundCatalog> catalogs;
  final int changeKeyCount;
}

class DeliveryTreeFile {
  const DeliveryTreeFile({required this.catalogPath, required this.content});

  final String catalogPath;
  final String content;
}

class SkippedReleaseKey {
  const SkippedReleaseKey({required this.messageId, required this.reason});

  final String messageId;
  final String reason;
}

class ReleaseDeliveryTree {
  const ReleaseDeliveryTree({
    required this.releaseRecord,
    required this.files,
    required this.applied,
    required this.skipped,
  });

  final ReleaseRecordIdentity releaseRecord;
  final List<DeliveryTreeFile> files;
  final List<String> applied;
  final List<SkippedReleaseKey> skipped;
}

/// The server decides catalog bytes and source-drift policy. The local adapter
/// supplies only the checkout's current bound catalogs.
abstract interface class ReleaseGateway {
  Future<ReleaseSummary> readRelease(String recordId);

  Future<ReleaseDeliveryTree> createDeliveryTree(
    String recordId,
    List<DeliveryTreeFile> files,
  );
}

class ReleaseDeliveryRequest {
  const ReleaseDeliveryRequest({
    required this.checkout,
    required this.recordId,
    required this.flutter,
    required this.gateway,
    required this.write,
    this.localeProposal,
  });

  final Directory checkout;
  final String recordId;
  final ResolvedFlutter flutter;
  final ReleaseGateway gateway;
  final void Function(String line) write;
  final LocaleProposalDeliveryInput? localeProposal;
}

class LocaleProposalDeliveryInput {
  const LocaleProposalDeliveryInput({
    required this.proposalId,
    required this.gateway,
  });

  final String proposalId;
  final LocaleProposalGateway gateway;
}

class ReleaseDeliveryResult {
  const ReleaseDeliveryResult({
    required this.branchName,
    required this.changedPaths,
    required this.applied,
    required this.skipped,
    required this.pullRequestBodyFile,
    required this.pullRequestCommand,
    required this.sourceChanged,
    this.localeProposalId,
  });

  final String branchName;
  final List<String> changedPaths;
  final List<String> applied;
  final List<SkippedReleaseKey> skipped;
  final String pullRequestBodyFile;
  final String pullRequestCommand;
  final bool sourceChanged;
  final String? localeProposalId;
}

class _VerifiedCandidate {
  const _VerifiedCandidate({required this.paths, required this.sourceChanged});

  final List<String> paths;
  final bool sourceChanged;
}

/// Delivers an immutable Release Bundle into the current integration branch.
/// Source drift skips a complete key on the server; target drift is replaced
/// with the reviewed value. Git and Flutter remain entirely local.
class ReleaseRepositoryAdapter {
  ReleaseRepositoryAdapter({CommandRunner runner = const SystemCommandRunner()})
    : _runner = runner;

  final CommandRunner _runner;
  static const _portuguese = PortugueseLocaleDelivery();

  Future<ReleaseDeliveryResult> deliver(ReleaseDeliveryRequest request) async {
    final summary = await request.gateway.readRelease(request.recordId);
    _validateSummary(summary, request.recordId);
    final localeInput = request.localeProposal;
    final localeArtifact = localeInput == null
        ? null
        : await _portuguese.prepare(
            localeInput.gateway,
            localeInput.proposalId,
          );
    if (localeArtifact != null) {
      _validateCombinedProvenance(summary, localeArtifact);
    }
    final localeValueCount = localeArtifact == null
        ? 0
        : _portuguese.catalogValueCount(localeArtifact);

    final checkout = await _repositoryRoot(request.checkout);
    await _ensureReleaseMatchesCheckout(checkout, summary);
    final currentBranch = await _currentBranch(checkout);
    if (currentBranch != summary.releaseRecord.integrationBranch) {
      throw RepositoryAdapterException(
        'This checkout is on $currentBranch, but this release delivers into ${summary.releaseRecord.integrationBranch}. Check out ${summary.releaseRecord.integrationBranch} and retry.',
      );
    }
    await _ensureRelevantPathsAreClean(
      checkout,
      summary.catalogs,
      additionalPaths: localeArtifact == null
          ? const {}
          : _portuguese.relevantPaths,
    );
    if (localeArtifact != null) await _ensureCheckoutIsClean(checkout);
    await _ensureCommitIdentity(checkout);
    final appliedOnto = await _git(checkout, ['rev-parse', 'HEAD']);
    final commitDistance = await _git(checkout, [
      'rev-list',
      '--left-right',
      '--count',
      '${summary.releaseRecord.baselineCommit}...$appliedOnto',
    ]);
    final branchName = 'blabla/release-${summary.releaseRecord.id}';
    await _ensureBranchDoesNotExist(checkout, branchName);
    final generatedBefore = (await _gitLines(checkout, [
      'ls-files',
      '--',
      '$_l10nDirectory/*.dart',
    ])).toSet();
    await _assertRegularLocalizationFiles(
      checkout,
      summary.catalogs,
      generatedBefore,
      additionalPaths: localeArtifact == null
          ? const {}
          : {_portuguese.runtimeConstantsPath},
    );

    final staging = await StagingWorktree.create(
      _runner,
      checkout,
      prefix: 'blabla-release-',
      commit: appliedOnto,
    );
    try {
      await _assertRegularLocalizationFiles(
        staging.root,
        summary.catalogs,
        generatedBefore,
        additionalPaths: localeArtifact == null
            ? const {}
            : {_portuguese.runtimeConstantsPath},
      );
      await _runGenerator(staging.root, request.flutter);
      if ((await _changedPaths(staging.root)).isNotEmpty) {
        throw RepositoryAdapterException(
          'Flutter localization output is already drifted in this checkout. Regenerate and commit it before delivering this release. ${request.flutter.description}',
        );
      }
      final signaturesBefore = await _generatedInterfaceSignatures(
        staging.root,
      );
      final inputFiles = await _readBoundCatalogs(
        staging.root,
        summary.catalogs,
      );
      final delivery = await request.gateway.createDeliveryTree(
        request.recordId,
        inputFiles,
      );
      _validateDelivery(summary, delivery);
      if (delivery.applied.isEmpty && localeArtifact == null) {
        final detail = delivery.skipped.isEmpty
            ? 'The Release Bundle contains no applicable catalog changes.'
            : 'Every release key was skipped because its Source Contract changed or disappeared.';
        throw RepositoryAdapterException(
          '$detail No review branch was created.',
        );
      }

      await _writeDeliveryTree(staging.root, delivery.files);
      if (localeArtifact != null) {
        await _portuguese.apply(staging.root, localeArtifact);
      }
      await _runGenerator(staging.root, request.flutter);
      final signaturesAfter = await _generatedInterfaceSignatures(staging.root);
      if (!_sameSet(signaturesBefore, signaturesAfter)) {
        throw RepositoryAdapterException(
          'Flutter generation changed the public localization interface. The release introduced a getter or method signature change and was not written.',
        );
      }
      final verifiedCandidate = await _verifiedCandidatePaths(
        staging.root,
        summary,
        delivery,
        inputFiles,
        generatedBefore,
        request.flutter,
        localeArtifact: localeArtifact,
      );
      final changedPaths = verifiedCandidate.paths;
      final sourceChanged = verifiedCandidate.sourceChanged;
      final candidateFiles = await _readCandidateFiles(
        staging.root,
        changedPaths,
      );

      final current = await request.gateway.readRelease(request.recordId);
      _validateSameRelease(summary, current);
      if (localeArtifact != null) {
        await _portuguese.ensureUnchanged(localeInput!.gateway, localeArtifact);
      }

      await _ensureRelevantPathsAreClean(
        checkout,
        summary.catalogs,
        additionalPaths: localeArtifact == null
            ? const {}
            : _portuguese.relevantPaths,
      );
      if (localeArtifact != null) await _ensureCheckoutIsClean(checkout);
      await _assertRegularLocalizationFiles(
        checkout,
        summary.catalogs,
        generatedBefore,
        additionalPaths: localeArtifact == null
            ? const {}
            : {_portuguese.runtimeConstantsPath},
      );
      await staging.ensureCheckoutUnchanged(currentBranch);

      await _git(checkout, ['switch', '-c', branchName]);
      await _writeCandidateFiles(checkout, candidateFiles);
      await _git(checkout, ['add', '--', ...changedPaths]);
      final stagedPaths = await _gitLines(checkout, [
        'diff',
        '--cached',
        '--name-only',
        '--',
        ...changedPaths,
      ]);
      if (!_sameSet(stagedPaths.toSet(), changedPaths.toSet())) {
        throw RepositoryAdapterException(
          'The local Git index changed while the release was being prepared. No commit was created.',
        );
      }
      final commitTitle = localeArtifact == null
          ? sourceChanged
                ? 'fix(l10n): deliver reviewed localization'
                : 'fix(l10n): deliver reviewed translations'
          : sourceChanged
          ? 'feat(l10n): deliver reviewed localization and Portuguese'
          : 'feat(l10n): deliver reviewed translations and Portuguese';
      final localeTrailers = localeArtifact == null
          ? ''
          : '\nBlabla-Locale-Proposal: ${localeArtifact.proposalId}\nBlabla-Locale-Values: $localeValueCount\nBlabla-Source-Snapshot: ${localeArtifact.sourceSnapshot.id}';
      await _git(checkout, [
        'commit',
        '--only',
        '-m',
        '$commitTitle\n\nBlabla-Release-Record: ${summary.releaseRecord.id}\nBlabla-Baseline-Commit: ${summary.releaseRecord.baselineCommit}\nBlabla-Applied-Onto: $appliedOnto\nBlabla-Applied-Keys: ${delivery.applied.length}\nBlabla-Source-Changed: ${sourceChanged ? 'yes' : 'no'}\nBlabla-Skipped-Keys: ${delivery.skipped.length}$localeTrailers',
        '--',
        ...changedPaths,
      ]);

      final body = _pullRequestBody(
        summary,
        delivery,
        appliedOnto,
        localeArtifact: localeArtifact,
        localeValueCount: localeValueCount,
        sourceChanged: sourceChanged,
      );
      final pullRequestBodyFile = await _writePullRequestBody(
        checkout,
        summary.releaseRecord.id,
        body,
      );
      final pullRequestCommand =
          'gh pr create --base ${summary.releaseRecord.integrationBranch} --head $branchName --title "$commitTitle" --body-file ${_shellQuote(pullRequestBodyFile)}';
      request.write('Created local branch $branchName.');
      request.write(
        'Git distance from the Baseline (baseline-only, checkout-only): $commitDistance.',
      );
      request.write(
        localeArtifact == null
            ? 'Applied ${delivery.applied.length} reviewed key${delivery.applied.length == 1 ? '' : 's'}${sourceChanged ? ', including reviewed Source changes' : ''}; skipped ${delivery.skipped.length}.'
            : 'Applied ${delivery.applied.length} reviewed key${delivery.applied.length == 1 ? '' : 's'}${sourceChanged ? ', including reviewed Source changes' : ''}; added Portuguese with $localeValueCount catalog value${localeValueCount == 1 ? '' : 's'}; skipped ${delivery.skipped.length}.',
      );
      for (final skipped in delivery.skipped) {
        request.write('Skipped ${skipped.messageId}: ${skipped.reason}.');
      }
      request.write('Review it, then run: git push -u origin $branchName');
      if (await _commandIsAvailable(checkout, 'gh')) {
        request.write(pullRequestCommand);
      } else {
        request.write('Pull-request body: $pullRequestBodyFile');
      }
      return ReleaseDeliveryResult(
        branchName: branchName,
        changedPaths: changedPaths,
        applied: delivery.applied,
        skipped: delivery.skipped,
        pullRequestBodyFile: pullRequestBodyFile,
        pullRequestCommand: pullRequestCommand,
        sourceChanged: sourceChanged,
        localeProposalId: localeArtifact?.proposalId,
      );
    } finally {
      await staging.dispose();
    }
  }

  void _validateSummary(ReleaseSummary summary, String recordId) {
    final record = summary.releaseRecord;
    final paths = summary.catalogs
        .map((catalog) => catalog.catalogPath)
        .toSet();
    if (record.id != recordId ||
        !RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(record.id) ||
        summary.changeKeyCount < 0 ||
        summary.catalogs.isEmpty ||
        summary.catalogs.length > 20 ||
        paths.length != summary.catalogs.length ||
        summary.catalogs.where((catalog) => catalog.isSource).length != 1 ||
        summary.catalogs.any(
          (catalog) =>
              catalog.localeCode.isEmpty ||
              !_isSafeRelativePath(catalog.catalogPath),
        ) ||
        !_isValidIntegrationBranch(record.integrationBranch) ||
        !RegExp(
          r'^[0-9a-f]{7,64}$',
          caseSensitive: false,
        ).hasMatch(record.baselineCommit) ||
        !RegExp(
          r'^[0-9a-f]{64}$',
          caseSensitive: false,
        ).hasMatch(record.manifestHash)) {
      throw RepositoryAdapterException(
        'Blabla returned an invalid existing-locale Release Bundle summary.',
      );
    }
  }

  void _validateDelivery(ReleaseSummary summary, ReleaseDeliveryTree delivery) {
    _validateSameRelease(
      summary,
      ReleaseSummary(
        releaseRecord: delivery.releaseRecord,
        catalogs: summary.catalogs,
        changeKeyCount: summary.changeKeyCount,
      ),
    );
    final expectedPaths = summary.catalogs
        .map((catalog) => catalog.catalogPath)
        .toSet();
    final actualPaths = delivery.files.map((file) => file.catalogPath).toSet();
    if (!_sameSet(expectedPaths, actualPaths) ||
        delivery.files.length != actualPaths.length ||
        delivery.applied.toSet().length != delivery.applied.length ||
        delivery.skipped.map((key) => key.messageId).toSet().length !=
            delivery.skipped.length ||
        delivery.skipped.any(
          (key) =>
              key.reason != 'missing_source' && key.reason != 'source_changed',
        )) {
      throw RepositoryAdapterException(
        'Blabla returned an invalid existing-locale delivery tree.',
      );
    }
  }

  void _validateCombinedProvenance(
    ReleaseSummary summary,
    LocaleProposalArtifact artifact,
  ) {
    final record = summary.releaseRecord;
    final sourceCatalog = summary.catalogs.singleWhere(
      (catalog) => catalog.isSource,
    );
    if (_normalizeRepository(record.repository) !=
            _normalizeRepository(artifact.sourceSnapshot.repository) ||
        record.baselineSnapshotId != artifact.sourceSnapshot.id ||
        record.baselineCommit != artifact.sourceSnapshot.commit ||
        record.manifestHash != artifact.sourceSnapshot.manifestHash ||
        record.integrationBranch != artifact.sourceSnapshot.integrationBranch ||
        sourceCatalog.catalogPath != artifact.sourceSnapshot.catalogPath) {
      throw RepositoryAdapterException(
        'The Release Bundle and Portuguese Locale Proposal do not share the same repository, Baseline, Source Snapshot, and Integration Branch.',
      );
    }
  }

  void _validateSameRelease(ReleaseSummary expected, ReleaseSummary actual) {
    final left = expected.releaseRecord;
    final right = actual.releaseRecord;
    if (left.id != right.id ||
        left.projectId != right.projectId ||
        left.baselineSnapshotId != right.baselineSnapshotId ||
        left.repository != right.repository ||
        left.baselineCommit != right.baselineCommit ||
        left.manifestHash != right.manifestHash ||
        left.integrationBranch != right.integrationBranch) {
      throw RepositoryAdapterException(
        'The Release Bundle changed while delivery was being prepared.',
      );
    }
  }

  Future<Directory> _repositoryRoot(Directory checkout) async {
    if (!await checkout.exists()) {
      throw RepositoryAdapterException('Brickit checkout does not exist.');
    }
    return Directory(await _git(checkout, ['rev-parse', '--show-toplevel']));
  }

  Future<void> _ensureReleaseMatchesCheckout(
    Directory checkout,
    ReleaseSummary summary,
  ) async {
    final remote = await _git(checkout, [
      'remote',
      'get-url',
      '--all',
      'origin',
    ]);
    final expected = _normalizeRepository(summary.releaseRecord.repository);
    final remotes = remote
        .split('\n')
        .where((value) => value.trim().isNotEmpty)
        .map(_normalizeRepository)
        .toSet();
    if (!remotes.contains(expected)) {
      throw RepositoryAdapterException(
        'The release belongs to ${summary.releaseRecord.repository}, not this checkout.',
      );
    }
    final commit = summary.releaseRecord.baselineCommit;
    final result = await _run(checkout, 'git', [
      'cat-file',
      '-e',
      '$commit^{commit}',
    ]);
    if (result.exitCode != 0) {
      throw RepositoryAdapterException(
        'The release baseline $commit is not available in this checkout. Run `git fetch origin $commit` and retry.',
      );
    }
    for (final catalog in summary.catalogs) {
      if (!await _file(checkout, catalog.catalogPath).exists()) {
        throw RepositoryAdapterException(
          'Brickit is missing the bound Catalog Document ${catalog.catalogPath}.',
        );
      }
    }
  }

  String _normalizeRepository(String value) {
    var normalized = value.trim().replaceFirst(RegExp(r'^[a-z]+://'), '');
    normalized = normalized.replaceFirst(RegExp(r'^[^@]+@'), '');
    normalized = normalized.replaceFirst(':', '/');
    normalized = normalized.replaceFirst(RegExp(r'^/+'), '');
    normalized = normalized.replaceFirst(RegExp(r'\.git/?$'), '');
    return normalized.toLowerCase();
  }

  Future<void> _ensureRelevantPathsAreClean(
    Directory checkout,
    List<BoundCatalog> catalogs, {
    Set<String> additionalPaths = const {},
  }) async {
    final paths = {
      _l10nDirectory,
      _l10nConfigPath,
      ...catalogs.map((catalog) => catalog.catalogPath),
      ...additionalPaths,
    };
    final output = await _git(checkout, [
      'status',
      '--porcelain',
      '--',
      ...paths,
    ]);
    if (output.isNotEmpty) {
      throw RepositoryAdapterException(
        'Brickit has uncommitted localization changes. Commit or stash them before delivering this release.',
      );
    }
  }

  Future<void> _ensureCheckoutIsClean(Directory checkout) async {
    if ((await _git(checkout, ['status', '--porcelain'])).isNotEmpty) {
      throw RepositoryAdapterException(
        'Combined localization delivery requires a clean Brickit checkout. Commit or stash all local changes and retry.',
      );
    }
  }

  Future<void> _ensureCommitIdentity(Directory checkout) async {
    for (final key in ['user.name', 'user.email']) {
      final result = await _run(checkout, 'git', ['config', '--get', key]);
      if (result.exitCode != 0 || result.stdout.trim().isEmpty) {
        throw RepositoryAdapterException(
          'Git $key must be configured before creating a release review branch.',
        );
      }
    }
  }

  Future<String> _currentBranch(Directory checkout) async {
    final branch = await _git(checkout, ['branch', '--show-current']);
    if (branch.isEmpty) {
      throw RepositoryAdapterException(
        'Brickit is detached at HEAD. Check out the integration branch first.',
      );
    }
    return branch;
  }

  Future<void> _ensureBranchDoesNotExist(
    Directory checkout,
    String branchName,
  ) async {
    final result = await _run(checkout, 'git', [
      'show-ref',
      '--verify',
      '--quiet',
      'refs/heads/$branchName',
    ]);
    if (result.exitCode == 1) return;
    if (result.exitCode == 0) {
      throw RepositoryAdapterException(
        'Local branch $branchName already exists. Review or remove it before retrying.',
      );
    }
    throw _commandFailure('git show-ref', result);
  }

  Future<void> _runGenerator(
    Directory checkout,
    ResolvedFlutter flutter,
  ) async {
    final package = Directory(
      '${checkout.path}${Platform.pathSeparator}packages${Platform.pathSeparator}brickit_generated',
    );
    await _regularFile(checkout, _l10nConfigPath);
    final result = await _run(package, flutter.executable, [
      ...flutter.argumentsPrefix,
      'gen-l10n',
    ]);
    if (result.exitCode != 0) {
      throw RepositoryAdapterException(
        'Flutter localization generation failed before the Brickit checkout was changed. ${flutter.description}. ${_failureDetail(result)}',
      );
    }
  }

  Future<List<DeliveryTreeFile>> _readBoundCatalogs(
    Directory checkout,
    List<BoundCatalog> catalogs,
  ) async {
    final files = <DeliveryTreeFile>[];
    for (final catalog in catalogs) {
      files.add(
        DeliveryTreeFile(
          catalogPath: catalog.catalogPath,
          content: await (await _regularFile(
            checkout,
            catalog.catalogPath,
          )).readAsString(),
        ),
      );
    }
    return files;
  }

  Future<void> _writeDeliveryTree(
    Directory checkout,
    List<DeliveryTreeFile> files,
  ) async {
    for (final file in files) {
      await (await _regularFile(
        checkout,
        file.catalogPath,
      )).writeAsString(file.content, flush: true);
    }
  }

  Future<_VerifiedCandidate> _verifiedCandidatePaths(
    Directory staging,
    ReleaseSummary summary,
    ReleaseDeliveryTree delivery,
    List<DeliveryTreeFile> inputFiles,
    Set<String> generatedBefore,
    ResolvedFlutter flutter, {
    LocaleProposalArtifact? localeArtifact,
  }) async {
    final changed = await _changedPaths(staging);
    final catalogPaths = summary.catalogs
        .map((catalog) => catalog.catalogPath)
        .toSet();
    final inputByPath = {
      for (final file in inputFiles) file.catalogPath: file.content,
    };
    final changedCatalogPaths = delivery.files
        .where((file) => inputByPath[file.catalogPath] != file.content)
        .map((file) => file.catalogPath)
        .toSet();
    if (delivery.applied.isNotEmpty && changedCatalogPaths.isEmpty) {
      throw RepositoryAdapterException(
        'Blabla reported applied release keys without changing any bound catalog bytes.',
      );
    }
    final sourcePath = summary.catalogs
        .singleWhere((catalog) => catalog.isSource)
        .catalogPath;
    final sourceChanged = changedCatalogPaths.contains(sourcePath);
    final combinedGeneratedPaths = localeArtifact == null
        ? const <String>{}
        : {
            for (final catalog in summary.catalogs.where(
              (catalog) => changedCatalogPaths.contains(catalog.catalogPath),
            ))
              if (generatedBefore.contains(
                '$_l10nDirectory/app_localizations_${catalog.localeCode}.dart',
              ))
                '$_l10nDirectory/app_localizations_${catalog.localeCode}.dart',
            _portuguese.generatedLocalizationPath,
            _portuguese.generatedLocalePath,
          };
    final allowed = localeArtifact == null
        ? {...catalogPaths, ...generatedBefore}
        : {
            ...changedCatalogPaths,
            ...(sourceChanged ? generatedBefore : const <String>{}),
            ...combinedGeneratedPaths,
            _portuguese.catalogPath,
            _portuguese.runtimeConstantsPath,
          };
    if (changed.isEmpty || !allowed.containsAll(changed)) {
      throw RepositoryAdapterException(
        'Flutter generation changed an unexpected surface. Refusing to write the checkout. ${flutter.description}',
      );
    }
    if (localeArtifact == null && !changed.any(catalogPaths.contains)) {
      throw RepositoryAdapterException(
        'The Release Bundle applied no catalog-byte change. No review branch was created.',
      );
    }
    for (final expected in delivery.files) {
      if (await (await _regularFile(
            staging,
            expected.catalogPath,
          )).readAsString() !=
          expected.content) {
        throw RepositoryAdapterException(
          'Flutter generation rewrote ${expected.catalogPath} after Blabla authored it.',
        );
      }
    }
    if (localeArtifact != null) {
      final required = {
        ...changedCatalogPaths,
        ...combinedGeneratedPaths,
        ..._portuguese.expectedChangedPaths,
      };
      if (!changed.containsAll(required)) {
        throw RepositoryAdapterException(
          'Combined delivery did not produce the complete Portuguese catalog, runtime mapping, and generated localization surface.',
        );
      }
      await _portuguese.verifyGenerated(staging, localeArtifact, flutter);
    }
    return _VerifiedCandidate(
      paths: changed.toList()..sort(),
      sourceChanged: sourceChanged,
    );
  }

  Future<Set<String>> _changedPaths(Directory checkout) async {
    final tracked = await _gitLines(checkout, ['diff', '--name-only']);
    final untracked = await _gitLines(checkout, [
      'ls-files',
      '--others',
      '--exclude-standard',
    ]);
    return {...tracked, ...untracked};
  }

  Future<Map<String, List<int>>> _readCandidateFiles(
    Directory checkout,
    List<String> paths,
  ) async {
    final files = <String, List<int>>{};
    for (final path in paths) {
      files[path] = await (await _regularFile(checkout, path)).readAsBytes();
    }
    return files;
  }

  Future<void> _writeCandidateFiles(
    Directory checkout,
    Map<String, List<int>> files,
  ) async {
    for (final entry in files.entries) {
      final destination = await _safeCandidateDestination(checkout, entry.key);
      await destination.parent.create(recursive: true);
      await destination.writeAsBytes(entry.value, flush: true);
    }
  }

  Future<File> _safeCandidateDestination(
    Directory root,
    String relativePath,
  ) async {
    if (!_isSafeRelativePath(relativePath)) {
      throw RepositoryAdapterException(
        'Localization path is not a safe repository-relative file: $relativePath.',
      );
    }
    var current = root.path;
    final segments = relativePath.split('/');
    for (final segment in segments.take(segments.length - 1)) {
      current = '$current${Platform.pathSeparator}$segment';
      if (await FileSystemEntity.type(current, followLinks: false) ==
          FileSystemEntityType.link) {
        throw RepositoryAdapterException(
          'Blabla refuses symlinked localization paths: $relativePath.',
        );
      }
    }
    final destination = _file(root, relativePath);
    final destinationType = await FileSystemEntity.type(
      destination.path,
      followLinks: false,
    );
    if (destinationType == FileSystemEntityType.link ||
        (destinationType != FileSystemEntityType.notFound &&
            destinationType != FileSystemEntityType.file)) {
      throw RepositoryAdapterException(
        'Blabla refuses a non-file localization destination: $relativePath.',
      );
    }
    return destination;
  }

  Future<void> _assertRegularLocalizationFiles(
    Directory checkout,
    List<BoundCatalog> catalogs,
    Set<String> generatedPaths, {
    Set<String> additionalPaths = const {},
  }) async {
    for (final path in {
      _l10nConfigPath,
      ...catalogs.map((catalog) => catalog.catalogPath),
      ...generatedPaths,
      ...additionalPaths,
    }) {
      await _regularFile(checkout, path);
    }
  }

  Future<File> _regularFile(Directory root, String relativePath) async {
    if (!_isSafeRelativePath(relativePath)) {
      throw RepositoryAdapterException(
        'Localization path is not a safe repository-relative file: $relativePath.',
      );
    }
    var current = root.path;
    for (final segment in relativePath.split('/')) {
      current = '$current${Platform.pathSeparator}$segment';
      final type = await FileSystemEntity.type(current, followLinks: false);
      if (type == FileSystemEntityType.link) {
        throw RepositoryAdapterException(
          'Blabla refuses symlinked localization paths: $relativePath.',
        );
      }
    }
    final file = File(current);
    if (!await file.exists()) {
      throw RepositoryAdapterException(
        'Brickit is missing the expected localization file $relativePath.',
      );
    }
    final rootPath = await root.resolveSymbolicLinks();
    final resolvedPath = await file.resolveSymbolicLinks();
    final rootPrefix = rootPath.endsWith(Platform.pathSeparator)
        ? rootPath
        : '$rootPath${Platform.pathSeparator}';
    if (!resolvedPath.startsWith(rootPrefix)) {
      throw RepositoryAdapterException(
        'Localization path escapes the disposable worktree: $relativePath.',
      );
    }
    return file;
  }

  Future<Set<String>> _generatedInterfaceSignatures(Directory checkout) async {
    final file = await _regularFile(
      checkout,
      '$_l10nDirectory/app_localizations.dart',
    );
    final source = await file.readAsString();
    final withoutComments = source
        .replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '')
        .replaceAll(RegExp(r'//[^\n]*'), '');
    return RegExp(
      r'\bString\s+(?:get\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\([^;{}]*\))?\s*;',
      multiLine: true,
    ).allMatches(withoutComments).map((match) {
      return (match.group(0) as String).replaceAll(RegExp(r'\s+'), ' ').trim();
    }).toSet();
  }

  String _pullRequestBody(
    ReleaseSummary summary,
    ReleaseDeliveryTree delivery,
    String appliedOnto, {
    LocaleProposalArtifact? localeArtifact,
    required int localeValueCount,
    required bool sourceChanged,
  }) {
    final skipped = delivery.skipped.isEmpty
        ? '- None'
        : delivery.skipped
              .map((key) => '- `${key.messageId}` — `${key.reason}`')
              .join('\n');
    return '''Delivers reviewed Blabla localization work.

- Release Record: `${summary.releaseRecord.id}`
- Baseline: `${summary.releaseRecord.baselineCommit}`
- Applied onto: `$appliedOnto`
- Reviewed keys applied: ${delivery.applied.length}
- Source catalog changed: ${sourceChanged ? 'yes' : 'no'}${localeArtifact == null ? '' : '\n- Portuguese catalog values added: $localeValueCount\n- Locale Proposal: `${localeArtifact.proposalId}`\n- Source Snapshot: `${localeArtifact.sourceSnapshot.id}`'}

Skipped keys

$skipped''';
  }

  Future<String> _writePullRequestBody(
    Directory checkout,
    String recordId,
    String body,
  ) async {
    final gitPath = await _git(checkout, [
      'rev-parse',
      '--git-path',
      'blabla/release-$recordId-pr.md',
    ]);
    final file = File(gitPath).isAbsolute
        ? File(gitPath)
        : File('${checkout.path}${Platform.pathSeparator}$gitPath');
    await file.parent.create(recursive: true);
    await file.writeAsString(body, flush: true);
    return file.absolute.path;
  }

  String _shellQuote(String value) => "'${value.replaceAll("'", "'\\''")}'";

  bool _isSafeRelativePath(String path) =>
      path.isNotEmpty &&
      !path.startsWith('/') &&
      !path.contains('\\') &&
      !path.split('/').contains('..') &&
      !path.split('/').contains('.') &&
      !path.contains('//');

  File _file(Directory root, String relativePath) => File(
    '${root.path}${Platform.pathSeparator}${relativePath.replaceAll('/', Platform.pathSeparator)}',
  );

  Future<String> _git(Directory checkout, List<String> arguments) async {
    final result = await _run(checkout, 'git', arguments);
    if (result.exitCode != 0) {
      throw _commandFailure('git ${arguments.join(' ')}', result);
    }
    return result.stdout.trim();
  }

  Future<List<String>> _gitLines(
    Directory checkout,
    List<String> arguments,
  ) async {
    final output = await _git(checkout, arguments);
    if (output.isEmpty) return const [];
    return output.split('\n').where((line) => line.isNotEmpty).toList();
  }

  Future<CommandResult> _run(
    Directory checkout,
    String executable,
    List<String> arguments,
  ) => _runner.run(executable, arguments, workingDirectory: checkout.path);

  Future<bool> _commandIsAvailable(
    Directory checkout,
    String executable,
  ) async {
    try {
      final result = await _run(checkout, executable, const ['--version']);
      return result.exitCode == 0;
    } on RepositoryAdapterException {
      return false;
    }
  }

  RepositoryAdapterException _commandFailure(
    String command,
    CommandResult result,
  ) => RepositoryAdapterException('$command failed. ${_failureDetail(result)}');

  String _failureDetail(CommandResult result) {
    final detail = result.stderr.trim().isNotEmpty
        ? result.stderr.trim()
        : result.stdout.trim();
    return detail.isEmpty ? 'Exit code ${result.exitCode}.' : detail;
  }

  bool _sameSet(Set<String> left, Set<String> right) =>
      left.length == right.length && left.containsAll(right);
}

bool _isValidIntegrationBranch(String branch) {
  return branch.length <= 128 &&
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._/-]*$').hasMatch(branch) &&
      !branch.contains('..') &&
      !branch.contains('//') &&
      !branch.contains('/.') &&
      !branch.contains('@{') &&
      !branch.endsWith('/') &&
      !branch.endsWith('.') &&
      !branch.endsWith('.lock');
}
