import 'dart:io';

import 'command_runner.dart';
import 'flutter_toolchain.dart';
import 'staging_worktree.dart';

/// Separates reproducible maintenance of existing locale implementations from
/// the release delta. The shared interface, catalogs, and file set must stay
/// unchanged. Candidate verification then compares against this fresh baseline.
class GeneratedLocalizationBaseline {
  GeneratedLocalizationBaseline._(this.runner, this.files);

  final CommandRunner runner;
  final Map<String, List<int>> files;
  static const _directory = 'packages/brickit_generated/lib/l10n';
  static const _title = 'chore(l10n): refresh generated localization';

  static Future<GeneratedLocalizationBaseline> prepare({
    required StagingWorktree staging,
    required ResolvedFlutter flutter,
    required Future<void> Function() generate,
  }) async {
    final baseline = GeneratedLocalizationBaseline._(staging.runner, {});
    final tracked = (await baseline._git(staging.root, [
      'ls-files',
      '-z',
      '--',
      '$_directory/app_localizations_*.dart',
    ])).split('\x00').where((path) => path.isNotEmpty).toSet();
    await generate();
    final changed = await baseline._changedPaths(staging.root);
    if (changed.isEmpty) return baseline;

    Future<Never> stop(String reason, String nextStep) async {
      final report = await baseline._saveReport(staging, changed);
      throw RepositoryAdapterException(
        'Delivery paused before changing your checkout.\n'
        'Generating from the existing catalogs changed ${changed.length} file(s), before applying translations.\n'
        '$reason\n${flutter.description}\n'
        'Changed files:\n${(changed.toList()..sort()).map((path) => '  $path').join('\n')}\n'
        'Review the differences: $report\nNext step: $nextStep\n'
        'Then retry the same delivery command.',
      );
    }

    final sdkProblem = flutter.refreshBlockReason;
    if (sdkProblem != null) {
      await stop(
        sdkProblem,
        'Select the intended installed SDK with --flutter-sdk <path>, or set up the repository FVM SDK. Do not commit output from an unintended SDK.',
      );
    }
    final structuralChanges = await baseline._git(staging.root, [
      'diff',
      '--summary',
    ]);
    if (!tracked.containsAll(changed) || structuralChanges.trim().isNotEmpty) {
      await stop(
        'Generation changed the shared localization interface, catalogs, file set, permissions, or another unexpected surface. Only existing locale implementation files can be refreshed automatically.',
        'Review the saved diff with the application developer and resolve the SDK, generator configuration, or source change it identifies.',
      );
    }
    for (final path in changed) {
      final file = await baseline._regularFile(staging.root, path);
      baseline.files[path] = await file.readAsBytes();
    }
    await generate();
    final repeatedPaths = await baseline._changedPaths(staging.root);
    var reproducible =
        changed.length == repeatedPaths.length &&
        changed.containsAll(repeatedPaths);
    if ((await baseline._git(staging.root, [
      'diff',
      '--summary',
    ])).trim().isNotEmpty) {
      changed.addAll(repeatedPaths);
      await stop(
        'Repeated generation changed the file set or permissions.',
        'Resolve the generator changes shown in the saved diff before delivering.',
      );
    }
    for (final entry in baseline.files.entries) {
      final file = await baseline._regularFile(staging.root, entry.key);
      final repeated = await file.readAsBytes();
      if (!_sameBytes(entry.value, repeated)) reproducible = false;
    }
    if (!reproducible) {
      changed.addAll(repeatedPaths);
      await stop(
        'Running generation twice produced different output; a reliable refresh could not be prepared.',
        'Fix the non-reproducible generator output using the saved diff before delivering.',
      );
    }
    await baseline._commit(staging.root, flutter);
    final residue = await baseline._changedPaths(staging.root);
    if (residue.isNotEmpty) {
      changed.addAll(residue);
      await stop(
        'The staging checkout changed while committing the refresh.',
        'Resolve local Git hook changes before delivering.',
      );
    }
    try {
      await staging.verifyCandidate(baseline.files);
    } on RepositoryAdapterException catch (error) {
      await stop(
        error.message,
        'Resolve the Git hook changes shown in the saved diff before delivering.',
      );
    }
    return baseline;
  }

  Future<void> _commit(Directory checkout, ResolvedFlutter flutter) async {
    await _git(checkout, ['add', '--', ...files.keys]);
    await _git(checkout, [
      'commit',
      '--only',
      '-m',
      '$_title\n\nRegenerated existing catalogs before applying Blabla translations.\n${flutter.description}',
      '--',
      ...files.keys,
    ]);
  }

  Future<String> _saveReport(StagingWorktree staging, Set<String> paths) async {
    final gitDirectory = (await _git(staging.checkout, [
      'rev-parse',
      '--absolute-git-dir',
    ])).trim();
    final reports = Directory('$gitDirectory/blabla/diagnostics');
    await reports.create(recursive: true);
    final directory = await reports.createTemp('generation-');
    final report = File('${directory.path}/baseline.diff');
    final diff = StringBuffer(
      await _git(staging.root, [
        'diff',
        staging.commit,
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
      ]),
    );
    final untracked = (await _git(staging.root, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])).split('\x00').where((path) => path.isNotEmpty);
    for (final path in untracked) {
      try {
        await _regularFile(staging.root, path);
      } on RepositoryAdapterException {
        diff.writeln('Untracked path is not a regular file: $path');
        continue;
      }
      final result = await runner.run('git', [
        'diff',
        '--no-index',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        '/dev/null',
        path,
      ], workingDirectory: staging.root.path);
      if (result.exitCode <= 1) diff.write(result.stdout);
    }
    await report.writeAsString(
      'Existing-catalog generation at ${staging.commit}\nChanged paths:\n${(paths.toList()..sort()).join('\n')}\n\n$diff',
    );
    return report.path;
  }

  Future<Set<String>> _changedPaths(Directory checkout) async => {
    ...(await _git(checkout, [
      'diff',
      'HEAD',
      '--name-only',
      '-z',
    ])).split('\x00').where((path) => path.isNotEmpty),
    ...(await _git(checkout, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])).split('\x00').where((path) => path.isNotEmpty),
  };

  Future<File> _regularFile(Directory checkout, String path) async {
    var current = checkout.path;
    for (final segment in path.split('/')) {
      current = '$current/$segment';
      if (await FileSystemEntity.type(current, followLinks: false) ==
          FileSystemEntityType.link) {
        throw RepositoryAdapterException(
          'Blabla refuses symlinked localization paths: $path.',
        );
      }
    }
    if (await FileSystemEntity.type(current, followLinks: false) !=
        FileSystemEntityType.file) {
      throw RepositoryAdapterException(
        'Expected a regular generated localization file: $path.',
      );
    }
    return File(current);
  }

  Future<String> _git(Directory checkout, List<String> arguments) async {
    final result = await runner.run(
      'git',
      arguments,
      workingDirectory: checkout.path,
    );
    if (result.exitCode != 0)
      throw RepositoryAdapterException(
        'Could not prepare generated localization: ${result.stderr.trim()}',
      );
    return result.stdout;
  }

  static bool _sameBytes(List<int> left, List<int> right) {
    if (left.length != right.length) return false;
    for (var index = 0; index < left.length; index++) {
      if (left[index] != right[index]) return false;
    }
    return true;
  }
}
