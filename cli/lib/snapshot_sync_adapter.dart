import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import 'cli_version.dart';
import 'command_runner.dart';
import 'repository_policy.dart';

const _maxFiles = 1000;
const _maxBytes = 8 * 1024 * 1024;

class SnapshotBinding {
  const SnapshotBinding({
    required this.localeCode,
    required this.catalogPath,
    required this.isSource,
  });

  final String localeCode;
  final String catalogPath;
  final bool isSource;
}

class SyncBaseline {
  const SyncBaseline({
    required this.id,
    required this.repository,
    required this.commit,
    required this.manifestHash,
    required this.kind,
  });

  final String id;
  final String repository;
  final String commit;
  final String manifestHash;
  final String kind;
}

class SnapshotSyncContext {
  const SnapshotSyncContext({
    required this.version,
    required this.canSubmit,
    required this.setupIssues,
    required this.repository,
    required this.bindings,
    required this.baseline,
    required this.maxFiles,
    required this.maxBytes,
    this.integrationBranch = defaultIntegrationBranch,
  });

  final int version;
  final bool canSubmit;
  final List<String> setupIssues;
  final String? repository;
  final List<SnapshotBinding> bindings;
  final SyncBaseline? baseline;
  final int maxFiles;
  final int maxBytes;
  final String integrationBranch;
}

class SnapshotSyncReceipt {
  const SnapshotSyncReceipt({
    required this.version,
    required this.runId,
    required this.status,
    required this.snapshotId,
    required this.diagnosticCount,
    required this.diagnostics,
    required this.unboundLocaleFileCount,
    required this.absentTargetLocaleCount,
    this.unboundLocaleFiles = const [],
    this.syncUrl,
  });

  final int version;
  final String runId;
  final String status;
  final String? snapshotId;
  final int diagnosticCount;
  final List<SnapshotDiagnostic> diagnostics;
  final int unboundLocaleFileCount;
  final int absentTargetLocaleCount;
  final List<UnboundCatalogFile> unboundLocaleFiles;
  final String? syncUrl;

  bool get succeeded => status == 'succeeded';
}

class UnboundCatalogFile {
  const UnboundCatalogFile({
    required this.catalogPath,
    this.declaredLocaleCode,
  });
  final String catalogPath;
  final String? declaredLocaleCode;
}

class SnapshotDiagnostic {
  const SnapshotDiagnostic({required this.message, this.catalogPath});

  final String message;
  final String? catalogPath;
}

abstract interface class SnapshotSyncGateway {
  Future<SnapshotSyncContext> readContext();

  Future<SnapshotSyncReceipt> submit({
    required String repository,
    required String commit,
    required List<SnapshotFile> files,
    SnapshotLineage? lineage,
  });
}

class SnapshotFile {
  const SnapshotFile({required this.catalogPath, required this.content});

  final String catalogPath;
  final String content;
}

class SnapshotLineage {
  const SnapshotLineage({
    required this.baselineCommit,
    required this.relationship,
    required this.mergeBase,
  });

  final String baselineCommit;
  final String relationship;
  final String mergeBase;
}

/// The HTTP adapter for the Repository Adapter transport. It is intentionally
/// separate from the Agent API client: the server scope and wire namespace are
/// different even though both use the same compatibility headers.
class HttpSnapshotSyncGateway implements SnapshotSyncGateway {
  HttpSnapshotSyncGateway({
    required this.baseUrl,
    required this.token,
    this.onWarning,
  });

  final Uri baseUrl;
  final String token;
  final void Function(String line)? onWarning;
  final _compatibility = CliCompatibility();

  @override
  Future<SnapshotSyncContext> readContext() async {
    final response = await _request('GET', '/snapshot-context');
    final bindings = _requiredList(response, 'bindings')
        .map((value) {
          final object = _object(value);
          return SnapshotBinding(
            localeCode: _requiredString(object, 'localeCode'),
            catalogPath: _requiredString(object, 'catalogPath'),
            isSource: _requiredBool(object, 'isSource'),
          );
        })
        .toList(growable: false);
    final baselineValue = response['baseline'];
    final baseline = baselineValue == null
        ? null
        : (() {
            final object = _object(baselineValue);
            return SyncBaseline(
              id: _requiredString(object, 'id'),
              repository: _requiredString(object, 'repository'),
              commit: _requiredString(object, 'commit'),
              manifestHash: _requiredString(object, 'manifestHash'),
              kind: _requiredString(object, 'kind'),
            );
          })();
    final limits = _object(response['limits']);
    return SnapshotSyncContext(
      version: _requiredInt(response, 'version'),
      canSubmit: _requiredBool(response, 'canSubmit'),
      setupIssues: _requiredList(
        response,
        'setupIssues',
      ).map((value) => _string(value, 'setup issue')).toList(growable: false),
      repository: _optionalString(response, 'repository'),
      integrationBranch:
          _optionalString(response, 'integrationBranch') ??
          defaultIntegrationBranch,
      bindings: bindings,
      baseline: baseline,
      maxFiles: _requiredInt(limits, 'maxFiles'),
      maxBytes: _requiredInt(limits, 'maxBytes'),
    );
  }

  @override
  Future<SnapshotSyncReceipt> submit({
    required String repository,
    required String commit,
    required List<SnapshotFile> files,
    SnapshotLineage? lineage,
  }) async {
    final upload = await _request(
      'POST',
      '/snapshot-uploads',
      body: {
        'repository': repository,
        'commit': commit,
        'expectedFiles': files.length,
        if (lineage != null)
          'lineage': {
            'baselineCommit': lineage.baselineCommit,
            'relationship': lineage.relationship,
            'mergeBase': lineage.mergeBase,
          },
      },
    );
    final sessionId = _requiredString(upload, 'sessionId');
    for (final file in files) {
      await _request(
        'POST',
        '/snapshot-uploads/file',
        body: {
          'sessionId': sessionId,
          'catalogPath': file.catalogPath,
          'content': file.content,
          'contentHash': sha256.convert(utf8.encode(file.content)).toString(),
        },
      );
    }
    final response = await _request(
      'POST',
      '/snapshot-uploads/finalize',
      body: {'sessionId': sessionId},
    );
    final run = _object(response['run']);
    final diagnostics = _requiredList(run, 'diagnostics')
        .map((value) {
          final object = _object(value);
          return SnapshotDiagnostic(
            message: _requiredString(object, 'message'),
            catalogPath: _optionalString(object, 'catalogPath'),
          );
        })
        .toList(growable: false);
    return SnapshotSyncReceipt(
      version: _requiredInt(response, 'version'),
      syncUrl: _optionalString(response, 'syncUrl'),
      runId: _requiredString(run, 'id'),
      status: _requiredString(run, 'status'),
      snapshotId: _optionalString(run, 'snapshotId'),
      diagnosticCount: _requiredInt(run, 'diagnosticCount'),
      diagnostics: diagnostics,
      unboundLocaleFileCount: _requiredInt(run, 'unboundLocaleFileCount'),
      absentTargetLocaleCount: _requiredInt(run, 'absentTargetLocaleCount'),
      unboundLocaleFiles: run['unboundLocaleFiles'] == null
          ? const []
          : _requiredList(run, 'unboundLocaleFiles')
                .map((value) {
                  final file = _object(value);
                  return UnboundCatalogFile(
                    catalogPath: _requiredString(file, 'catalogPath'),
                    declaredLocaleCode: _optionalString(
                      file,
                      'declaredLocaleCode',
                    ),
                  );
                })
                .toList(growable: false),
    );
  }

  Future<Map<String, Object?>> _request(
    String method,
    String suffix, {
    Map<String, Object?>? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await (method == 'GET'
          ? client.getUrl(_endpoint(suffix))
          : client.postUrl(_endpoint(suffix)));
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      _compatibility.stamp(request.headers);
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      }
      final response = await request.close();
      final text = await utf8.decoder.bind(response).join();
      _compatibility.check(response.headers, onWarning: onWarning);
      if (response.statusCode != HttpStatus.ok) {
        throw RepositoryAdapterException(
          'Blabla rejected the snapshot sync request (${response.statusCode}). ${_errorMessage(text)}',
        );
      }
      try {
        return _object(jsonDecode(text));
      } on FormatException {
        throw RepositoryAdapterException(
          'Blabla returned an invalid snapshot sync response.',
        );
      }
    } on SocketException catch (error) {
      throw RepositoryAdapterException(
        'Could not reach Blabla to sync the checkout: ${error.message}',
      );
    } finally {
      client.close(force: true);
    }
  }

  Uri _endpoint(String suffix) {
    final prefix = baseUrl.path == '/'
        ? ''
        : baseUrl.path.endsWith('/')
        ? baseUrl.path.substring(0, baseUrl.path.length - 1)
        : baseUrl.path;
    return baseUrl.replace(path: '$prefix/api/repository-adapter/v1$suffix');
  }

  String _errorMessage(String body) {
    try {
      final object = _object(jsonDecode(body));
      final error = object['error'];
      if (error is String && error.isNotEmpty) return error;
    } on FormatException {
      // The status line remains useful when a proxy returned non-JSON text.
    }
    return 'Check the checkout, token scope, and project setup.';
  }
}

/// A read-only local sync adapter. It owns Git/filesystem access and leaves
/// all Snapshot identity, parsing, diagnostics, and publication policy to the
/// server.
class RepositorySyncAdapter {
  RepositorySyncAdapter({CommandRunner runner = const SystemCommandRunner()})
    : _runner = runner;

  final CommandRunner _runner;

  Future<SnapshotSyncReceipt> sync({
    required Directory checkout,
    required SnapshotSyncGateway gateway,
    required void Function(String line) write,
  }) async {
    final root = await _repositoryRoot(checkout);
    final context = await gateway.readContext();
    if (!context.canSubmit) {
      throw RepositoryAdapterException(
        'Sync setup is incomplete:\n${context.setupIssues.map((issue) => '- $issue').join('\n')}',
      );
    }
    final repository = await _repository(root);
    final currentBranch = await _currentBranch(root);
    if (currentBranch != context.integrationBranch) {
      throw RepositoryAdapterException(
        'This checkout is on $currentBranch, but this project syncs from ${context.integrationBranch}. Check out ${context.integrationBranch} and retry.',
      );
    }
    if (context.repository != null &&
        _normalizeRepository(context.repository!) !=
            _normalizeRepository(repository)) {
      throw RepositoryAdapterException(
        'This project is connected to ${context.repository}, not this checkout remote.',
      );
    }
    final commit = await _git(root, ['rev-parse', 'HEAD']);
    final files = await _readCommittedFiles(root, context);
    final capturedHead = await _git(root, ['rev-parse', 'HEAD']);
    if (capturedHead != commit) {
      throw RepositoryAdapterException(
        'Brickit HEAD changed while the catalogs were being read. Retry sync from a stable checkout.',
      );
    }
    final lineage = await _lineage(root, context.baseline?.commit, commit);
    final receipt = await gateway.submit(
      repository: repository,
      commit: commit,
      files: files,
      lineage: lineage,
    );
    write(
      receipt.succeeded
          ? 'Sync succeeded: ${receipt.snapshotId ?? 'preview'} (${files.length} files).'
          : 'Sync recorded a failed run ${receipt.runId}.',
    );
    for (final diagnostic in receipt.diagnostics) {
      write(
        diagnostic.catalogPath == null
            ? 'Diagnostic: ${diagnostic.message}'
            : 'Diagnostic (${diagnostic.catalogPath}): ${diagnostic.message}',
      );
    }
    if (receipt.unboundLocaleFileCount > 0) {
      write(
        'Found ${receipt.unboundLocaleFileCount} catalog file(s) not yet included in Blabla:',
      );
      for (final file in receipt.unboundLocaleFiles) {
        // Quote repository-controlled text so unusual paths cannot inject terminal controls.
        write(
          '  ${jsonEncode(file.catalogPath)} — locale: ${file.declaredLocaleCode == null ? "not declared (@@locale missing)" : jsonEncode(file.declaredLocaleCode)}',
        );
      }
      if (receipt.syncUrl != null)
        write('Review discovered files: ${receipt.syncUrl}');
      write(
        'Open Blabla → Sync → Discovered catalog files to review and add each language. No new sync is needed for files in the accepted catalog.',
      );
    }
    return receipt;
  }

  Future<Directory> _repositoryRoot(Directory checkout) async {
    if (!await checkout.exists()) {
      throw RepositoryAdapterException('Brickit checkout does not exist.');
    }
    final root = await _git(checkout, ['rev-parse', '--show-toplevel']);
    return Directory(root);
  }

  Future<String> _repository(Directory root) async {
    final remote = await _git(root, ['remote', 'get-url', 'origin']);
    return remote.trim();
  }

  Future<String> _currentBranch(Directory root) async {
    final branch = await _git(root, ['branch', '--show-current']);
    if (branch.isEmpty) {
      throw RepositoryAdapterException(
        'Brickit is detached at HEAD. Check out ${defaultIntegrationBranch} before syncing.',
      );
    }
    return branch;
  }

  Future<List<SnapshotFile>> _readCommittedFiles(
    Directory root,
    SnapshotSyncContext context,
  ) async {
    final files = <SnapshotFile>[];
    final directories = <String>{};
    for (final binding in context.bindings) {
      _assertRelativePath(binding.catalogPath);
      final file = File(_join(root.path, binding.catalogPath));
      directories.add(_relative(root.path, file.parent.path));
    }
    final treeResult = await _runner.run('git', [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      'HEAD',
      '--',
      ...directories.map((directory) => ':(literal)$directory'),
    ], workingDirectory: root.path);
    if (treeResult.exitCode != 0) {
      throw RepositoryAdapterException(
        'Git could not enumerate the committed catalog files: ${treeResult.stderr.trim()}',
      );
    }
    final committedPaths = treeResult.stdout
        .split('\x00')
        .where((path) => path.isNotEmpty)
        .where(
          (path) =>
              path.toLowerCase().endsWith('.arb') &&
              directories.contains(_parentPath(path)),
        )
        .toSet();
    for (final binding in context.bindings) {
      if (!committedPaths.contains(binding.catalogPath)) {
        if (binding.isSource) {
          throw RepositoryAdapterException(
            'The bound source catalog ${binding.catalogPath} is missing from HEAD.',
          );
        }
      }
    }
    for (final path in committedPaths) {
      files.add(
        SnapshotFile(
          catalogPath: path,
          content: await _readCommittedUtf8(root, path),
        ),
      );
    }
    files.sort((left, right) => left.catalogPath.compareTo(right.catalogPath));
    if (files.length > context.maxFiles || files.length > _maxFiles) {
      throw RepositoryAdapterException(
        'This checkout contains more than ${context.maxFiles} catalog files. Remove extras or bind them deliberately before syncing.',
      );
    }
    for (final file in files) {
      if (utf8.encode(file.content).length > _maxBytes) {
        throw RepositoryAdapterException(
          'Catalog ${file.catalogPath} exceeds the $_maxBytes-byte per-file sync limit.',
        );
      }
    }
    return files;
  }

  Future<String> _readCommittedUtf8(Directory root, String path) async {
    final file = File(_join(root.path, path));
    final type = await FileSystemEntity.type(file.path, followLinks: false);
    if (type == FileSystemEntityType.link) {
      throw RepositoryAdapterException(
        'Catalog $path is a symbolic link. Source Snapshots require committed regular files.',
      );
    }
    if (type != FileSystemEntityType.file) {
      throw RepositoryAdapterException(
        'Committed catalog $path is missing from the working tree.',
      );
    }
    final bytes = await file.readAsBytes();
    final committedHash = await _git(root, ['rev-parse', 'HEAD:$path']);
    final workingHash = await _runner.run(
      'git',
      ['hash-object', '--path=$path', '--stdin'],
      workingDirectory: root.path,
      stdin: bytes,
    );
    if (workingHash.exitCode != 0) {
      throw RepositoryAdapterException(
        'Git could not verify catalog $path against HEAD: ${workingHash.stderr.trim()}',
      );
    }
    if (workingHash.stdout.trim() != committedHash) {
      throw RepositoryAdapterException(
        'Catalog $path does not match its committed blob at HEAD. Commit or discard the catalog change before retrying.',
      );
    }
    return _decodeUtf8(bytes, path);
  }

  String _decodeUtf8(List<int> bytes, String path) {
    try {
      final content = utf8.decode(bytes, allowMalformed: false);
      // Keep the round-trip check explicit: the server receives the exact
      // UTF-8 document, not a Dart-normalized replacement string.
      if (!_sameBytes(utf8.encode(content), bytes)) {
        throw RepositoryAdapterException(
          'Catalog $path could not be preserved as UTF-8 bytes.',
        );
      }
      return content;
    } on FormatException {
      throw RepositoryAdapterException(
        'Catalog $path is not valid UTF-8; sync preserves bytes and will not replace them.',
      );
    }
  }

  Future<SnapshotLineage?> _lineage(
    Directory root,
    String? baselineCommit,
    String commit,
  ) async {
    if (baselineCommit == null || baselineCommit == commit) return null;
    final mergeBase = await _tryGit(root, [
      'merge-base',
      baselineCommit,
      commit,
    ]);
    if (mergeBase == null || mergeBase.isEmpty) return null;
    final baselineAncestor = await _isAncestor(root, baselineCommit, commit);
    final commitAncestor = await _isAncestor(root, commit, baselineCommit);
    final relationship = baselineAncestor
        ? 'descendant'
        : commitAncestor
        ? 'ancestor'
        : 'divergent';
    return SnapshotLineage(
      baselineCommit: baselineCommit,
      relationship: relationship,
      mergeBase: mergeBase,
    );
  }

  Future<bool> _isAncestor(
    Directory root,
    String ancestor,
    String descendant,
  ) async {
    final result = await _runner.run('git', [
      'merge-base',
      '--is-ancestor',
      ancestor,
      descendant,
    ], workingDirectory: root.path);
    return result.exitCode == 0;
  }

  Future<String?> _tryGit(Directory root, List<String> arguments) async {
    try {
      final result = await _runner.run(
        'git',
        arguments,
        workingDirectory: root.path,
      );
      if (result.exitCode != 0) return null;
      final value = result.stdout.trim();
      return value.isEmpty ? null : value;
    } on RepositoryAdapterException {
      return null;
    }
  }

  Future<String> _git(Directory root, List<String> arguments) async {
    final result = await _runner.run(
      'git',
      arguments,
      workingDirectory: root.path,
    );
    if (result.exitCode != 0) {
      throw RepositoryAdapterException(
        'Git ${arguments.join(' ')} failed: ${result.stderr.trim()}',
      );
    }
    final value = result.stdout.trim();
    if (value.isEmpty) {
      throw RepositoryAdapterException(
        'Git ${arguments.join(' ')} returned no value.',
      );
    }
    return value;
  }
}

void _assertRelativePath(String path) {
  if (path.isEmpty ||
      path.startsWith('/') ||
      path.contains('\\') ||
      path.split('/').contains('..')) {
    throw RepositoryAdapterException(
      'Catalog path $path is not repository-relative.',
    );
  }
}

String _join(String root, String relative) =>
    '$root${Platform.pathSeparator}${relative.replaceAll('/', Platform.pathSeparator)}';

String _relative(String root, String absolute) {
  final prefix = root.endsWith(Platform.pathSeparator)
      ? root
      : '$root${Platform.pathSeparator}';
  return absolute.startsWith(prefix)
      ? absolute
            .substring(prefix.length)
            .replaceAll(Platform.pathSeparator, '/')
      : absolute.replaceAll(Platform.pathSeparator, '/');
}

String _parentPath(String path) {
  final separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.substring(0, separator);
}

String _normalizeRepository(String value) {
  var normalized = value.trim().replaceFirst(RegExp(r'^[a-z]+://'), '');
  normalized = normalized.replaceFirst(RegExp(r'^[^@]+@'), '');
  normalized = normalized.replaceFirst(':', '/');
  normalized = normalized.replaceFirst(RegExp(r'^/+'), '');
  normalized = normalized.replaceFirst(RegExp(r'\.git/?$'), '');
  return normalized.toLowerCase();
}

Map<String, Object?> _object(Object? value) {
  if (value is! Map) throw const FormatException();
  final object = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String) throw const FormatException();
    object[entry.key as String] = entry.value;
  }
  return object;
}

List<Object?> _requiredList(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! List) throw const FormatException();
  return value.cast<Object?>();
}

String _requiredString(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! String || value.isEmpty) throw const FormatException();
  return value;
}

String? _optionalString(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value == null) return null;
  if (value is! String) throw const FormatException();
  return value;
}

String _string(Object? value, String label) {
  if (value is! String) throw FormatException('$label must be a string');
  return value;
}

bool _requiredBool(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! bool) throw const FormatException();
  return value;
}

int _requiredInt(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! int) throw const FormatException();
  return value;
}

bool _sameBytes(List<int> left, List<int> right) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    if (left[index] != right[index]) return false;
  }
  return true;
}
