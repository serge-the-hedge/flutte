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
  /// before copying the candidate. A clean tree alone cannot detect a new commit.
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
