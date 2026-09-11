import 'dart:io';

import 'command_runner.dart';

/// A detached, disposable checkout used to prove a localization delivery
/// before any bytes are copied into the developer's working tree.
class StagingWorktree {
  StagingWorktree._({
    required this.runner,
    required this.checkout,
    required this.root,
    required this.parent,
    required this.commit,
  });

  final CommandRunner runner;
  final Directory checkout;
  final Directory root;
  final Directory parent;
  final String commit;

  static Future<StagingWorktree> create(
    CommandRunner runner,
    Directory checkout, {
    required String commit,
    String prefix = 'blabla-delivery-',
  }) async {
    final parent = await Directory.systemTemp.createTemp(prefix);
    final root = Directory('${parent.path}${Platform.pathSeparator}checkout');
    try {
      final result = await runner.run('git', [
        'worktree',
        'add',
        '--detach',
        root.path,
        commit,
      ], workingDirectory: checkout.path);
      if (result.exitCode != 0) {
        throw RepositoryAdapterException(
          'Could not create a disposable Brickit worktree. ${result.stderr.trim()}',
        );
      }
      return StagingWorktree._(
        runner: runner,
        checkout: checkout,
        root: root,
        parent: parent,
        commit: commit,
      );
    } catch (_) {
      await parent.delete(recursive: true);
      rethrow;
    }
  }

  /// Recheck the original branch and commit after remote validation, immediately
  /// before checking out the candidate. A clean tree alone cannot detect a new commit.
  Future<void> ensureCheckoutUnchanged(String expectedBranch) async {
    Future<String> git(List<String> arguments) async {
      final result = await runner.run(
        'git',
        arguments,
        workingDirectory: checkout.path,
      );
      if (result.exitCode != 0) {
        throw RepositoryAdapterException(
          'Could not verify the delivery checkout. ${result.stderr.trim()}',
        );
      }
      return result.stdout.trim();
    }

    final branch = await git(['branch', '--show-current']);
    final head = await git(['rev-parse', 'HEAD']);
    if (branch != expectedBranch || head != commit) {
      throw RepositoryAdapterException(
        'The Brickit checkout changed while delivery was being prepared. Retry from a stable integration-branch HEAD.',
      );
    }
  }

  /// Hooks run only in staging. Verify their committed result still matches the
  /// validated candidate before making it reachable from the review branch.
  Future<void> verifyCandidate(Map<String, List<int>> files) async {
    final status = await _git(root, ['status', '--porcelain']);
    final changed = (await _git(root, [
      'diff',
      '--name-only',
      '-z',
      commit,
      'HEAD',
    ])).split('\x00').where((path) => path.isNotEmpty);
    final summary = await _git(root, ['diff', '--summary', commit, 'HEAD']);
    if (status.isNotEmpty ||
        summary.contains('mode change') ||
        changed.any((path) => !files.containsKey(path))) {
      throw RepositoryAdapterException(
        'Git hooks changed the prepared delivery. The original checkout was not changed.',
      );
    }
    for (final entry in files.entries) {
      var path = root.path;
      for (final segment in entry.key.split('/')) {
        path = '$path/$segment';
        if (await FileSystemEntity.type(path, followLinks: false) ==
            FileSystemEntityType.link) {
          throw RepositoryAdapterException(
            'Git hooks introduced a symlink at ${entry.key}. The original checkout was not changed.',
          );
        }
      }
      final actual = await File(path).readAsBytes();
      final expected = entry.value;
      if (actual.length != expected.length ||
          Iterable<int>.generate(
            actual.length,
          ).any((index) => actual[index] != expected[index])) {
        throw RepositoryAdapterException(
          'Git hooks changed ${entry.key} after verification. The original checkout was not changed.',
        );
      }
    }
  }

  /// Let Git carry unrelated staged work across a single checkout operation;
  /// no generated files or partial commits are written by the adapter locally.
  Future<void> publish(String branchName) async {
    final candidate = await _git(root, ['rev-parse', 'HEAD']);
    await _git(checkout, ['switch', '-c', branchName, candidate]);
  }

  Future<String> _git(Directory directory, List<String> arguments) async {
    final result = await runner.run(
      'git',
      arguments,
      workingDirectory: directory.path,
    );
    if (result.exitCode != 0) {
      throw RepositoryAdapterException(
        'Could not prepare or check out the delivery branch: ${result.stderr.trim()}',
      );
    }
    return result.stdout.trim();
  }

  Future<void> dispose() async {
    try {
      await runner.run('git', [
        'worktree',
        'remove',
        '--force',
        root.path,
      ], workingDirectory: checkout.path);
    } finally {
      if (await parent.exists()) await parent.delete(recursive: true);
    }
  }
}
