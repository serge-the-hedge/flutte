import 'dart:convert';
import 'dart:io';

import 'command_runner.dart';

/// The only durable local state the CLI keeps. It is intentionally outside a
/// checkout: Blabla resolves project ownership server-side from the proposal.
class BlablaCredentials {
  const BlablaCredentials({required this.server, required this.token});

  final String server;
  final String token;
}

/// Stores an Agent API token at the user-level path required by the CLI
/// contract. Callers may still supply environment variables for CI or a
/// one-off invocation; neither route writes to a Brickit checkout.
class CredentialStore {
  CredentialStore({Directory? homeDirectory}) : _homeDirectory = homeDirectory;

  final Directory? _homeDirectory;

  File get file {
    final home = _homeDirectory?.path ?? Platform.environment['HOME'];
    if (home == null || home.isEmpty) {
      throw RepositoryAdapterException(
        'Could not locate a home directory for Blabla credentials.',
      );
    }
    return File(
      '$home${Platform.pathSeparator}.config${Platform.pathSeparator}blabla${Platform.pathSeparator}credentials.json',
    );
  }

  Future<BlablaCredentials?> read() async {
    final credentialsFile = file;
    if (!await credentialsFile.exists()) return null;
    if (!Platform.isWindows && (await credentialsFile.stat()).mode & 63 != 0) {
      throw RepositoryAdapterException(
        'Blabla credentials must be readable only by you. Run `chmod 600 ${credentialsFile.path}` and retry.',
      );
    }
    try {
      final decoded = jsonDecode(await credentialsFile.readAsString());
      if (decoded is! Map ||
          decoded['server'] is! String ||
          decoded['token'] is! String ||
          (decoded['server'] as String).isEmpty ||
          (decoded['token'] as String).isEmpty) {
        throw const FormatException();
      }
      return BlablaCredentials(
        server: decoded['server'] as String,
        token: decoded['token'] as String,
      );
    } on FormatException {
      throw RepositoryAdapterException(
        'Blabla credentials are not a valid credentials.json file. Run `blabla login` again.',
      );
    }
  }

  Future<void> write(BlablaCredentials credentials) async {
    final server = Uri.tryParse(credentials.server);
    if (server == null ||
        !server.hasScheme ||
        !{'http', 'https'}.contains(server.scheme) ||
        credentials.token.isEmpty) {
      throw RepositoryAdapterException(
        'Login requires an http or https server URL and a non-empty token.',
      );
    }
    final credentialsFile = file;
    await credentialsFile.parent.create(recursive: true);
    // Dart's Linux createTemp respects umask rather than guaranteeing 0700.
    // Protect the empty directory before writing; its location keeps rename atomic.
    final privateDirectory = await credentialsFile.parent.createTemp(
      '.credentials-',
    );
    final temporary = File(
      '${privateDirectory.path}${Platform.pathSeparator}credentials.json',
    );
    try {
      final protectDirectory = await Process.run('chmod', [
        '700',
        privateDirectory.path,
      ]);
      if (protectDirectory.exitCode != 0) {
        throw RepositoryAdapterException(
          'Could not protect the Blabla credentials directory.',
        );
      }
      await temporary.writeAsString(
        '${jsonEncode({'server': credentials.server, 'token': credentials.token})}\n',
        flush: true,
      );
      final chmod = await Process.run('chmod', ['600', temporary.path]);
      if (chmod.exitCode != 0) {
        throw RepositoryAdapterException(
          'Could not protect Blabla credentials at ${credentialsFile.path}.',
        );
      }
      await temporary.rename(credentialsFile.path);
    } finally {
      await privateDirectory.delete(recursive: true);
    }
  }
}
