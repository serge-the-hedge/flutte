import 'dart:convert';
import 'dart:io';

import 'command_runner.dart';

const maxCredentialFileBytes = 16 * 1024;
final _profileName = RegExp(r'^[a-z0-9][a-z0-9_-]{0,63}$');

/// A token and its destination are one credential, never independently defaulted.
class BlablaCredentials {
  const BlablaCredentials({required this.server, required this.token});

  final String server;
  final String token;

  BlablaCredentials validated() {
    final url = Uri.tryParse(server);
    final loopback =
        url != null &&
        (url.host == 'localhost' ||
            url.host == '127.0.0.1' ||
            url.host == '::1');
    if (url == null ||
        url.host.isEmpty ||
        url.userInfo.isNotEmpty ||
        url.hasQuery ||
        url.hasFragment ||
        (url.path.isNotEmpty && url.path != '/') ||
        (url.scheme != 'https' && !(url.scheme == 'http' && loopback)) ||
        server.contains(RegExp(r'\s'))) {
      throw RepositoryAdapterException(
        'Use an HTTPS server origin without a path, credentials, query, or fragment. HTTP is allowed only for loopback hosts.',
      );
    }
    if (token.isEmpty || token.length > 8192 || token.contains(RegExp(r'\s'))) {
      throw RepositoryAdapterException(
        'The token must contain 1–8192 characters without whitespace.',
      );
    }
    return BlablaCredentials(server: url.origin, token: token);
  }
}

/// Explicit profiles never fall back or mix with another token/server pair.
Future<BlablaCredentials> resolveCredentials({
  required Map<String, String> options,
  required Map<String, String> environment,
  CredentialStore? store,
}) async {
  final profile = options['profile'] ?? environment['BLABLA_PROFILE'];
  final explicit =
      options.containsKey('server') || options.containsKey('token');
  final canonical =
      environment.containsKey('BLABLA_API_URL') ||
      environment.containsKey('BLABLA_TOKEN');
  final legacyEnvironment =
      environment.containsKey('BLABLA_AGENT_URL') ||
      environment.containsKey('BLABLA_AGENT_TOKEN');
  if (profile != null) {
    if (explicit || canonical || legacyEnvironment) {
      throw RepositoryAdapterException(
        'A profile cannot be combined with server/token flags or credential environment variables. Clear those overrides and retry.',
      );
    }
    return (await (store ?? CredentialStore.forEnvironment(environment)).read(
      profile: profile,
    ))!;
  }
  BlablaCredentials pair(String? server, String? token) {
    if (server == null || token == null)
      throw RepositoryAdapterException(
        'Supply server and token together from the same source, or select a profile.',
      );
    return BlablaCredentials(server: server, token: token).validated();
  }

  if (explicit) return pair(options['server'], options['token']);
  if (canonical && legacyEnvironment)
    throw RepositoryAdapterException(
      'Use only one environment credential pair: BLABLA_API_URL/BLABLA_TOKEN or BLABLA_AGENT_URL/BLABLA_AGENT_TOKEN.',
    );
  if (canonical)
    return pair(environment['BLABLA_API_URL'], environment['BLABLA_TOKEN']);
  if (legacyEnvironment)
    return pair(
      environment['BLABLA_AGENT_URL'],
      environment['BLABLA_AGENT_TOKEN'],
    );
  final legacy = await (store ?? CredentialStore.forEnvironment(environment))
      .read();
  if (legacy == null)
    throw RepositoryAdapterException(
      'No credentials configured. Run `blabla login` or select a named profile.',
    );
  return legacy;
}

/// Private user-level credentials. Named stores are supported on POSIX only.
class CredentialStore {
  CredentialStore({Directory? homeDirectory}) : _homeDirectory = homeDirectory;

  factory CredentialStore.forEnvironment(Map<String, String> environment) {
    final home = environment['HOME'];
    if (home == null ||
        home.isEmpty ||
        !home.startsWith(Platform.pathSeparator)) {
      throw RepositoryAdapterException(
        'Could not locate a home directory for Blabla credentials.',
      );
    }
    return CredentialStore(homeDirectory: Directory(home));
  }

  final Directory? _homeDirectory;
  int? _uid;

  Directory get _home {
    final home = _homeDirectory?.path ?? Platform.environment['HOME'];
    if (home == null ||
        home.isEmpty ||
        !home.startsWith(Platform.pathSeparator)) {
      throw RepositoryAdapterException(
        'Could not locate a home directory for Blabla credentials.',
      );
    }
    return Directory(home);
  }

  Directory get _config => Directory('${_home.path}/.config');
  Directory get _root => Directory('${_config.path}/blabla');
  Directory get _profiles => Directory('${_root.path}/profiles');
  File get file => File('${_root.path}/credentials.json');

  File profileFile(String name) {
    if (_profileName.firstMatch(name)?.group(0) != name) {
      throw RepositoryAdapterException(
        'Profile names must be 1–64 lowercase letters, digits, underscores, or hyphens, starting with a letter or digit.',
      );
    }
    if (Platform.isWindows) {
      throw RepositoryAdapterException(
        'Named credential profiles require a POSIX system.',
      );
    }
    return File('${_profiles.path}/$name.json');
  }

  Future<void> _owned(String path) async {
    final uid = _uid ??= await _numericCommand('/usr/bin/id', ['-u']);
    final owner = await _numericCommand('/usr/bin/stat', [
      if (Platform.isMacOS) ...['-f', '%u'] else ...['-c', '%u'],
      path,
    ]);
    if (owner != uid) {
      throw RepositoryAdapterException(
        'Credential paths must be owned by the current user.',
      );
    }
  }

  Future<int> _numericCommand(String executable, List<String> arguments) async {
    final result = await Process.run(executable, arguments);
    final value = int.tryParse('${result.stdout}'.trim());
    if (result.exitCode != 0 || value == null) {
      throw RepositoryAdapterException(
        'Could not verify credential path ownership.',
      );
    }
    return value;
  }

  Future<void> _chmod(String path, String mode) async {
    final result = await Process.run('chmod', [mode, path]);
    if (result.exitCode != 0) {
      throw RepositoryAdapterException(
        'Could not protect the Blabla credential path.',
      );
    }
  }

  Future<bool> _directory(
    Directory directory, {
    required bool private,
    bool create = false,
  }) async {
    var type = await FileSystemEntity.type(directory.path, followLinks: false);
    if (type == FileSystemEntityType.notFound) {
      if (!create) return false;
      await directory.create();
      await _chmod(directory.path, '700');
      type = await FileSystemEntity.type(directory.path, followLinks: false);
    }
    if (type != FileSystemEntityType.directory) {
      throw RepositoryAdapterException(
        'Credential directories must be real directories, not symbolic links.',
      );
    }
    await _owned(directory.path);
    var mode = (await directory.stat()).mode;
    // Login may tighten an existing real, owned store, never an untrusted path.
    if (create && private && mode & 63 != 0) {
      await _chmod(directory.path, '700');
      mode = (await directory.stat()).mode;
    }
    if (mode & (private ? 63 : 18) != 0) {
      throw RepositoryAdapterException(
        'Credential directories have insecure permissions. Protect the Blabla store with chmod 700.',
      );
    }
    return true;
  }

  Future<bool> _parents({required bool named, bool create = false}) async {
    if (!await _directory(_config, private: false, create: create))
      return false;
    if (!await _directory(_root, private: named, create: create)) return false;
    return !named || await _directory(_profiles, private: true, create: create);
  }

  Future<bool> _checkFile(File target) async {
    final type = await FileSystemEntity.type(target.path, followLinks: false);
    if (type == FileSystemEntityType.notFound) return false;
    if (type != FileSystemEntityType.file) {
      throw RepositoryAdapterException(
        'Credentials must be a regular file, not a symbolic link.',
      );
    }
    if (!Platform.isWindows) await _owned(target.path);
    final stat = await target.stat();
    if ((!Platform.isWindows && stat.mode & 63 != 0) ||
        stat.size > maxCredentialFileBytes) {
      throw RepositoryAdapterException(
        'Credentials must be private to their owner and no larger than 16 KiB.',
      );
    }
    return true;
  }

  Future<BlablaCredentials?> read({String? profile}) async {
    final target = profile == null ? file : profileFile(profile);
    try {
      final exists =
          await _parents(named: profile != null) && await _checkFile(target);
      if (!exists) {
        if (profile != null)
          throw RepositoryAdapterException(
            'Credential profile "$profile" does not exist.',
          );
        return null;
      }
      final bytes = await target
          .openRead(0, maxCredentialFileBytes + 1)
          .fold<List<int>>([], (bytes, chunk) => bytes..addAll(chunk));
      if (bytes.length > maxCredentialFileBytes) throw const FormatException();
      final decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is! Map<String, dynamic> ||
          (profile != null && decoded['version'] != 1) ||
          decoded['server'] is! String ||
          decoded['token'] is! String) {
        throw const FormatException();
      }
      return BlablaCredentials(
        server: decoded['server'] as String,
        token: decoded['token'] as String,
      ).validated();
    } on FormatException {
      throw RepositoryAdapterException(
        'Invalid credential file. Run `blabla login` again.',
      );
    } on FileSystemException {
      throw RepositoryAdapterException(
        'Could not read Blabla credentials. Check the credential path and permissions.',
      );
    }
  }

  Future<void> write(
    BlablaCredentials credentials, {
    String? profile,
    bool replace = false,
  }) async {
    final value = credentials.validated();
    final encoded =
        '${jsonEncode({if (profile != null) 'version': 1, 'server': value.server, 'token': value.token})}\n';
    if (utf8.encode(encoded).length > maxCredentialFileBytes)
      throw RepositoryAdapterException(
        'Credential data exceeds the 16 KiB file limit.',
      );
    final target = profile == null ? file : profileFile(profile);
    try {
      await _parents(named: profile != null, create: true);
      if (await _checkFile(target) && profile != null && !replace)
        throw RepositoryAdapterException(
          'Profile "$profile" already exists. Use --replace to replace it deliberately.',
        );
      // Protect an empty same-filesystem directory before writing secret bytes.
      final staging = await target.parent.createTemp('.credentials-');
      try {
        await _chmod(staging.path, '700');
        final temporary = File('${staging.path}/credentials.json');
        await temporary.writeAsString(encoded, flush: true);
        await _chmod(temporary.path, '600');
        if (profile != null && !replace) {
          // Hard-link publication is atomic and fails if another login won.
          final published = await Process.run('/bin/ln', [
            if (Platform.isMacOS) '-h' else '-T',
            temporary.path,
            target.path,
          ]);
          if (published.exitCode != 0)
            throw RepositoryAdapterException(
              'Could not create the profile. It may already exist; use --replace only to replace it deliberately.',
            );
        } else {
          await temporary.rename(target.path);
        }
      } finally {
        await staging.delete(recursive: true);
      }
    } on FileSystemException {
      throw RepositoryAdapterException(
        'Could not save Blabla credentials. Check the credential path and permissions.',
      );
    }
  }

  Future<List<String>> listProfiles() async {
    profileFile('validation');
    if (!await _parents(named: true)) return [];
    final names = <String>[];
    await for (final entry in _profiles.list(followLinks: false)) {
      final basename = entry.path.split(Platform.pathSeparator).last;
      if (!basename.endsWith('.json')) continue;
      final name = basename.substring(0, basename.length - 5);
      if (_profileName.firstMatch(name)?.group(0) != name) continue;
      if (await _checkFile(File(entry.path))) names.add(name);
    }
    return names..sort();
  }

  Future<void> removeProfile(String profile) async {
    final target = profileFile(profile);
    if (!await _parents(named: true) || !await _checkFile(target)) {
      throw RepositoryAdapterException(
        'Credential profile "$profile" does not exist.',
      );
    }
    await target.delete();
  }
}
