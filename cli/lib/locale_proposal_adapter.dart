import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import 'command_runner.dart';
import 'flutter_toolchain.dart';
import 'generated_localization_baseline.dart';
import 'repository_policy.dart';
import 'runtime_locale_registration.dart';
import 'staging_worktree.dart';

export 'command_runner.dart';
export 'flutter_toolchain.dart';

const _l10nDirectory = 'packages/brickit_generated/lib/l10n';
const _l10nConfigPath = 'packages/brickit_generated/l10n.yaml';
const _sourceCatalogPath = 'packages/brickit_generated/lib/l10n/intl_en.arb';
const _runtimeConstantsPath =
    'packages/brickit/lib/constants/locale_const.dart';
const _generatedLocalizationPath =
    'packages/brickit_generated/lib/l10n/app_localizations.dart';

class SourceSnapshotIdentity {
  const SourceSnapshotIdentity({
    required this.id,
    required this.repository,
    required this.commit,
    required this.manifestHash,
    required this.catalogPath,
    this.integrationBranch = defaultIntegrationBranch,
  });

  final String id;
  final String repository;
  final String commit;
  final String manifestHash;
  final String catalogPath;
  final String integrationBranch;
}

class ProposedLocale {
  const ProposedLocale({
    required this.code,
    required this.label,
    required this.runtimeLocale,
  });

  final String code;
  final String label;
  final String runtimeLocale;
}

class ProposedCatalog {
  const ProposedCatalog({
    required this.fileName,
    required this.content,
    required this.contentHash,
    this.catalogPath,
  });

  final String? catalogPath;
  final String fileName;
  final String content;
  final String contentHash;
}

/// The constrained, server-authored output the adapter understands. Catalog
/// paths stay inside the adapter's localization directory; executable Flutter
/// source edits remain adapter-owned rather than arriving as arbitrary patches.
class LocaleProposalArtifact {
  const LocaleProposalArtifact({
    required this.version,
    required this.proposalId,
    required this.sourceSnapshot,
    required this.locale,
    required this.catalog,
  });

  final int version;
  final String proposalId;
  final SourceSnapshotIdentity sourceSnapshot;
  final ProposedLocale locale;
  final ProposedCatalog catalog;
}

class LocaleProposalSummary {
  const LocaleProposalSummary({
    required this.proposalId,
    required this.sourceSnapshotId,
    required this.status,
    required this.deliveryStatus,
  });

  final String proposalId;
  final String sourceSnapshotId;
  final String status;
  final String deliveryStatus;
}

/// The adapter's only Blabla seam. The concrete HTTP client is deliberately
/// outside this module's delivery implementation, so Git/toolchain tests stay
/// deterministic and the CLI cannot decide catalog bytes itself.
abstract interface class LocaleProposalGateway {
  Future<LocaleProposalSummary> readProposal(String proposalId);
  Future<LocaleProposalArtifact> readArtifact(String proposalId);
}

/// Owns the Locale artifact contract independently of Git orchestration.
/// Both the compatibility command and combined Release delivery use this one
/// boundary, so readiness, hashing, runtime registration, and generated-output
/// checks cannot diverge between the two flows.
class LocaleDelivery {
  const LocaleDelivery();

  Set<String> get relevantPaths => const {
    _l10nDirectory,
    _l10nConfigPath,
    _runtimeConstantsPath,
  };

  Set<String> expectedChangedPaths(LocaleProposalArtifact artifact) => {
    catalogPath(artifact),
    _runtimeConstantsPath,
    _generatedLocalizationPath,
    generatedLocalePath(artifact),
  };

  String catalogPath(LocaleProposalArtifact artifact) =>
      artifact.catalog.catalogPath ??
      '$_l10nDirectory/${artifact.catalog.fileName}';
  String get runtimeConstantsPath => _runtimeConstantsPath;
  String get generatedLocalizationPath => _generatedLocalizationPath;
  String generatedLocalePath(LocaleProposalArtifact artifact) =>
      '$_l10nDirectory/app_localizations_${artifact.locale.code}.dart';

  Future<LocaleProposalArtifact> prepare(
    LocaleProposalGateway gateway,
    String proposalId,
  ) async {
    await ensureCurrent(gateway, proposalId);
    final artifact = await gateway.readArtifact(proposalId);
    validateArtifact(artifact, proposalId);
    return artifact;
  }

  Future<void> ensureCurrent(
    LocaleProposalGateway gateway,
    String proposalId, {
    String? expectedSnapshotId,
  }) async {
    final summary = await gateway.readProposal(proposalId);
    if (summary.proposalId != proposalId ||
        summary.status != 'ready' ||
        summary.deliveryStatus != 'ready' ||
        (expectedSnapshotId != null &&
            summary.sourceSnapshotId != expectedSnapshotId)) {
      throw RepositoryAdapterException(
        'The Locale Proposal is not a current finalized delivery artifact.',
      );
    }
  }

  Future<void> ensureUnchanged(
    LocaleProposalGateway gateway,
    LocaleProposalArtifact expected,
  ) async {
    await ensureCurrent(
      gateway,
      expected.proposalId,
      expectedSnapshotId: expected.sourceSnapshot.id,
    );
    final current = await gateway.readArtifact(expected.proposalId);
    validateArtifact(current, expected.proposalId);
    if (current.sourceSnapshot.id != expected.sourceSnapshot.id ||
        current.sourceSnapshot.repository !=
            expected.sourceSnapshot.repository ||
        current.sourceSnapshot.integrationBranch !=
            expected.sourceSnapshot.integrationBranch ||
        current.sourceSnapshot.commit != expected.sourceSnapshot.commit ||
        current.sourceSnapshot.manifestHash !=
            expected.sourceSnapshot.manifestHash ||
        current.sourceSnapshot.catalogPath !=
            expected.sourceSnapshot.catalogPath ||
        current.locale.code != expected.locale.code ||
        current.locale.label != expected.locale.label ||
        current.locale.runtimeLocale != expected.locale.runtimeLocale ||
        current.catalog.fileName != expected.catalog.fileName ||
        catalogPath(current) != catalogPath(expected) ||
        current.catalog.contentHash != expected.catalog.contentHash ||
        current.catalog.content != expected.catalog.content) {
      throw RepositoryAdapterException(
        'The Locale Proposal artifact changed while delivery was being prepared.',
      );
    }
  }

  void validateArtifact(LocaleProposalArtifact artifact, String proposalId) {
    if (artifact.version != 1 ||
        artifact.proposalId != proposalId ||
        !RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(artifact.proposalId) ||
        !_validLocaleCode(artifact.locale.code) ||
        (artifact.catalog.catalogPath == null &&
            (artifact.locale.code != 'pt' ||
                artifact.catalog.fileName != 'intl_pt.arb')) ||
        artifact.locale.label.trim().isEmpty ||
        artifact.locale.label.length > 128 ||
        !_validRuntimeLocale(artifact.locale.runtimeLocale) ||
        !_runtimeMatchesCatalog(artifact.locale) ||
        !RegExp(r'^[A-Za-z0-9_-]+\.arb$').hasMatch(artifact.catalog.fileName) ||
        catalogPath(artifact) !=
            '$_l10nDirectory/${artifact.catalog.fileName}' ||
        catalogPath(artifact) == _sourceCatalogPath ||
        artifact.sourceSnapshot.catalogPath != _sourceCatalogPath ||
        !_isValidIntegrationBranch(artifact.sourceSnapshot.integrationBranch) ||
        !RegExp(
          r'^[0-9a-f]{7,64}$',
          caseSensitive: false,
        ).hasMatch(artifact.sourceSnapshot.commit) ||
        !RegExp(
          r'^[0-9a-f]{64}$',
          caseSensitive: false,
        ).hasMatch(artifact.sourceSnapshot.manifestHash) ||
        !RegExp(
          r'^[0-9a-f]{64}$',
          caseSensitive: false,
        ).hasMatch(artifact.catalog.contentHash) ||
        sha256.convert(utf8.encode(artifact.catalog.content)).toString() !=
            artifact.catalog.contentHash) {
      throw RepositoryAdapterException(
        'The delivery artifact is not the recognized Locale proposal format.',
      );
    }
    try {
      final document = jsonDecode(artifact.catalog.content);
      if (document is! Map || document['@@locale'] != artifact.locale.code) {
        throw const FormatException();
      }
    } on FormatException {
      throw RepositoryAdapterException(
        'The delivery artifact does not contain a valid Catalog Document.',
      );
    }
  }

  Future<void> ensureSourceCatalogUnchanged(
    Directory checkout,
    LocaleProposalArtifact artifact,
    String checkoutCommit,
    CommandRunner runner,
  ) async {
    final sourceDiff = await runner.run('git', [
      'diff',
      '--quiet',
      artifact.sourceSnapshot.commit,
      checkoutCommit,
      '--',
      artifact.sourceSnapshot.catalogPath,
    ], workingDirectory: checkout.path);
    if (sourceDiff.exitCode == 1) {
      throw RepositoryAdapterException(
        'The checkout Source Catalog changed since this Locale Proposal. Sync the current commit and prepare a current proposal before delivery.',
      );
    }
    if (sourceDiff.exitCode != 0) {
      throw RepositoryAdapterException(
        'Could not verify the proposal Source Catalog against this checkout.',
      );
    }
  }

  int catalogValueCount(LocaleProposalArtifact artifact) {
    final document = jsonDecode(artifact.catalog.content) as Map;
    return document.keys
        .whereType<String>()
        .where((key) => !key.startsWith('@'))
        .length;
  }

  Future<void> apply(
    Directory checkout,
    LocaleProposalArtifact artifact,
  ) async {
    final catalog = _fileAt(checkout, catalogPath(artifact));
    if (await catalog.exists()) {
      throw RepositoryAdapterException(
        'Brickit already has ${artifact.catalog.fileName}. Refusing to replace a Catalog Document.',
      );
    }
    await catalog.parent.create(recursive: true);
    await catalog.writeAsString(artifact.catalog.content, flush: true);
    final runtimeConstants = _fileAt(checkout, _runtimeConstantsPath);
    if (!await runtimeConstants.exists()) {
      throw RepositoryAdapterException(
        'Brickit no longer has the expected runtime locale registration file.',
      );
    }
    await runtimeConstants.writeAsString(
      addRuntimeLocaleMapping(
        await runtimeConstants.readAsString(),
        artifact.locale.runtimeLocale,
      ),
      flush: true,
    );
  }

  Future<void> verifyGenerated(
    Directory staging,
    LocaleProposalArtifact artifact,
    ResolvedFlutter flutter,
  ) async {
    final catalog = _fileAt(staging, catalogPath(artifact));
    if (!await catalog.exists() ||
        sha256.convert(await catalog.readAsBytes()).toString() !=
            artifact.catalog.contentHash) {
      throw RepositoryAdapterException(
        'The staged Catalog Document no longer matches the proposal artifact.',
      );
    }
    final generated = await _fileAt(
      staging,
      _generatedLocalizationPath,
    ).readAsString();
    final language = artifact.locale.code;
    final generatedLocale = _fileAt(staging, generatedLocalePath(artifact));
    final className =
        'AppLocalizations${language[0].toUpperCase()}${language.substring(1)}';
    if (!generated.contains("case '$language':") ||
        !generated.contains(className) ||
        !await generatedLocale.exists() ||
        !(await generatedLocale.readAsString()).contains('class $className')) {
      throw RepositoryAdapterException(
        'Flutter generation did not add the proposed Locale. ${flutter.description}',
      );
    }
  }
}

class DeliveryRequest {
  const DeliveryRequest({
    required this.checkout,
    required this.proposalId,
    required this.flutter,
    required this.gateway,
    required this.write,
  });

  final Directory checkout;
  final String proposalId;
  final ResolvedFlutter flutter;
  final LocaleProposalGateway gateway;
  final void Function(String line) write;
}

class DeliveryResult {
  const DeliveryResult({
    required this.branchName,
    required this.changedPaths,
    required this.pullRequestCommand,
  });

  final String branchName;
  final List<String> changedPaths;
  final String pullRequestCommand;
}

/// A deep local delivery module. It validates the server-authored artifact,
/// stages all writes and Flutter generation in a disposable Git worktree, then
/// creates exactly one local review branch. It never invokes Git network
/// commands.
class RepositoryAdapter {
  RepositoryAdapter({CommandRunner runner = const SystemCommandRunner()})
    : _runner = runner;

  final CommandRunner _runner;
  static const _localeDelivery = LocaleDelivery();

  Future<DeliveryResult> deliver(DeliveryRequest request) async {
    final artifact = await _localeDelivery.prepare(
      request.gateway,
      request.proposalId,
    );

    final checkout = await _repositoryRoot(request.checkout);
    final currentBranch = await _currentBranch(checkout);
    if (currentBranch != artifact.sourceSnapshot.integrationBranch) {
      throw RepositoryAdapterException(
        'This checkout is on $currentBranch, but this proposal delivers into ${artifact.sourceSnapshot.integrationBranch}. Check out ${artifact.sourceSnapshot.integrationBranch} and retry.',
      );
    }
    final appliedOnto = await _git(checkout, ['rev-parse', 'HEAD']);
    await _ensureArtifactMatchesCheckout(checkout, artifact, appliedOnto);
    await _ensureRelevantPathsAreClean(checkout);
    await _ensureIndexIsClean(checkout);
    await _ensureCommitIdentity(checkout);
    final branchName = 'blabla/locale-proposal-${artifact.proposalId}';
    await _ensureBranchDoesNotExist(checkout, branchName);

    final staging = await StagingWorktree.create(
      _runner,
      checkout,
      prefix: 'blabla-locale-proposal-',
      commit: appliedOnto,
    );
    try {
      final baseline = await GeneratedLocalizationBaseline.prepare(
        staging: staging,
        flutter: request.flutter,
        generate: () => _runGenerator(staging.root, request.flutter),
      );

      await _localeDelivery.apply(staging.root, artifact);
      await _runGenerator(staging.root, request.flutter);
      final changedPaths = await _verifiedCandidatePaths(
        staging.root,
        artifact,
        request.flutter,
      );
      final candidateFiles = await _readCandidateFiles(
        staging.root,
        changedPaths,
      );

      await _localeDelivery.ensureUnchanged(request.gateway, artifact);
      await _ensureRelevantPathsAreClean(checkout);
      await _ensureIndexIsClean(checkout);
      await staging.ensureCheckoutUnchanged(currentBranch);
      await _git(checkout, ['switch', '-c', branchName]);
      await baseline.writeCommit(checkout, request.flutter);
      await _writeCandidateFiles(checkout, candidateFiles);
      await _git(checkout, ['add', '--', ...changedPaths]);
      final stagedPaths = await _gitLines(checkout, [
        'diff',
        '--cached',
        '--name-only',
      ]);
      if (!_sameSet(stagedPaths.toSet(), changedPaths.toSet())) {
        throw RepositoryAdapterException(
          'The local Git index changed while this Locale was being prepared. No commit was created.',
        );
      }
      await _git(checkout, [
        'commit',
        '-m',
        'feat(l10n): add ${artifact.locale.code}\n\nBlabla-Locale-Proposal: ${artifact.proposalId}\nBlabla-Source-Snapshot: ${artifact.sourceSnapshot.id}',
      ]);

      final pullRequestCommand =
          'gh pr create --base ${artifact.sourceSnapshot.integrationBranch} --head $branchName --title "feat(l10n): add ${artifact.locale.code}"';
      request.write('Created local branch $branchName.');
      if (baseline.files.isNotEmpty) {
        request.write(
          'Refreshed ${baseline.files.length} existing generated localization file(s) in a separate preceding commit. Review both commits before pushing.',
        );
      }
      request.write('Review it, then run: git push -u origin $branchName');
      request.write(pullRequestCommand);
      return DeliveryResult(
        branchName: branchName,
        changedPaths: {...baseline.files.keys, ...changedPaths}.toList()
          ..sort(),
        pullRequestCommand: pullRequestCommand,
      );
    } finally {
      await staging.dispose();
    }
  }

  Future<Directory> _repositoryRoot(Directory checkout) async {
    if (!await checkout.exists()) {
      throw RepositoryAdapterException('Brickit checkout does not exist.');
    }
    final root = await _git(checkout, ['rev-parse', '--show-toplevel']);
    return Directory(root);
  }

  Future<void> _ensureArtifactMatchesCheckout(
    Directory checkout,
    LocaleProposalArtifact artifact,
    String checkoutCommit,
  ) async {
    final remote = await _git(checkout, [
      'remote',
      'get-url',
      '--all',
      'origin',
    ]);
    final expected = _normalizeRepository(artifact.sourceSnapshot.repository);
    final remotes = remote
        .split('\n')
        .where((value) => value.trim().isNotEmpty)
        .map(_normalizeRepository)
        .toSet();
    if (!remotes.contains(expected)) {
      throw RepositoryAdapterException(
        'The proposal belongs to ${artifact.sourceSnapshot.repository}, not this checkout.',
      );
    }
    final commit = artifact.sourceSnapshot.commit;
    final result = await _run(checkout, 'git', [
      'cat-file',
      '-e',
      '$commit^{commit}',
    ]);
    if (result.exitCode != 0) {
      throw RepositoryAdapterException(
        'The proposal source commit $commit is not available in this checkout. Run `git fetch origin $commit` and retry.',
      );
    }
    await _localeDelivery.ensureSourceCatalogUnchanged(
      checkout,
      artifact,
      checkoutCommit,
      _runner,
    );
  }

  String _normalizeRepository(String value) {
    var normalized = value.trim().replaceFirst(RegExp(r'^[a-z]+://'), '');
    normalized = normalized.replaceFirst(RegExp(r'^[^@]+@'), '');
    normalized = normalized.replaceFirst(':', '/');
    normalized = normalized.replaceFirst(RegExp(r'^/+'), '');
    normalized = normalized.replaceFirst(RegExp(r'\.git/?$'), '');
    return normalized.toLowerCase();
  }

  Future<void> _ensureRelevantPathsAreClean(Directory checkout) async {
    final output = await _git(checkout, [
      'status',
      '--porcelain',
      '--',
      _l10nDirectory,
      _l10nConfigPath,
      _runtimeConstantsPath,
    ]);
    if (output.isNotEmpty) {
      throw RepositoryAdapterException(
        'Brickit has uncommitted localization changes. Commit or stash the files this proposal would write first.',
      );
    }
  }

  Future<void> _ensureIndexIsClean(Directory checkout) async {
    final result = await _run(checkout, 'git', ['diff', '--cached', '--quiet']);
    if (result.exitCode == 0) return;
    if (result.exitCode == 1) {
      throw RepositoryAdapterException(
        'Brickit has staged changes. Commit or unstage them before creating a Locale review branch.',
      );
    }
    throw _commandFailure('git diff --cached --quiet', result);
  }

  Future<void> _ensureCommitIdentity(Directory checkout) async {
    for (final key in ['user.name', 'user.email']) {
      final result = await _run(checkout, 'git', ['config', '--get', key]);
      if (result.exitCode != 0 || result.stdout.trim().isEmpty) {
        throw RepositoryAdapterException(
          'Git $key must be configured before creating a Locale review branch.',
        );
      }
    }
  }

  Future<String> _currentBranch(Directory checkout) async {
    final branch = await _git(checkout, ['branch', '--show-current']);
    if (branch.isEmpty) {
      throw RepositoryAdapterException(
        'Brickit is detached at HEAD. Check out the branch you want to review against first.',
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
    if (!await File(
      '${package.path}${Platform.pathSeparator}l10n.yaml',
    ).exists()) {
      throw RepositoryAdapterException(
        'Brickit no longer has the expected packages/brickit_generated/l10n.yaml localization shape.',
      );
    }
    CommandResult result;
    try {
      result = await _run(package, flutter.executable, [
        ...flutter.argumentsPrefix,
        'gen-l10n',
      ]);
    } on RepositoryAdapterException catch (error) {
      throw RepositoryAdapterException(
        'Flutter localization generation failed before the Brickit checkout was changed. ${flutter.description}. ${error.message}',
      );
    }
    if (result.exitCode != 0) {
      throw RepositoryAdapterException(
        'Flutter localization generation failed before the Brickit checkout was changed. ${flutter.description}. ${_failureDetail(result)}',
      );
    }
  }

  Future<List<String>> _verifiedCandidatePaths(
    Directory staging,
    LocaleProposalArtifact artifact,
    ResolvedFlutter flutter,
  ) async {
    final changed = await _changedPaths(staging);
    final expected = _localeDelivery.expectedChangedPaths(artifact);
    if (!_sameSet(changed.toSet(), expected)) {
      throw RepositoryAdapterException(
        'Flutter generation changed an unexpected surface. Refusing to write the checkout. ${flutter.description}',
      );
    }
    await _localeDelivery.verifyGenerated(staging, artifact, flutter);
    return changed.toList()..sort();
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
      final file = _file(checkout, path);
      if (!await file.exists()) {
        throw RepositoryAdapterException(
          'Staged Locale delivery is missing $path.',
        );
      }
      files[path] = await file.readAsBytes();
    }
    return files;
  }

  Future<void> _writeCandidateFiles(
    Directory checkout,
    Map<String, List<int>> files,
  ) async {
    for (final entry in files.entries) {
      final destination = _file(checkout, entry.key);
      await destination.parent.create(recursive: true);
      await destination.writeAsBytes(entry.value, flush: true);
    }
  }

  File _file(Directory root, String relativePath) =>
      _fileAt(root, relativePath);

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

File _fileAt(Directory root, String relativePath) => File(
  '${root.path}${Platform.pathSeparator}${relativePath.replaceAll('/', Platform.pathSeparator)}',
);

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

// This adapter registers one language catalog; regional and script selection
// belongs to the explicit runtime mapping, not ARB metadata aliases.
bool _validLocaleCode(String code) => RegExp(r'^[a-z]{2,3}$').hasMatch(code);

bool _validRuntimeLocale(String code) => RegExp(
  r'^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$',
).hasMatch(code);

bool _runtimeMatchesCatalog(ProposedLocale locale) =>
    locale.runtimeLocale.split('-').first == locale.code;
