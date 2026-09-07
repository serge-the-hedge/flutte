import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import 'cli_version.dart';
import 'release_delivery_adapter.dart';

/// HTTP transport for immutable existing-locale Release Bundles. The API token
/// needs only the `export` scope for these two operations.
class HttpReleaseGateway implements ReleaseGateway {
  HttpReleaseGateway({
    required this.baseUrl,
    required this.token,
    this.onWarning,
  });

  final Uri baseUrl;
  final String token;
  final void Function(String line)? onWarning;
  final _compatibility = CliCompatibility();

  @override
  Future<ReleaseSummary> readRelease(String recordId) async {
    final response = await _request('GET', _endpoint(recordId));
    return _decodeResponse(() => _summary(response));
  }

  @override
  Future<ReleaseDeliveryTree> createDeliveryTree(
    String recordId,
    List<DeliveryTreeFile> files,
  ) async {
    final summary = await readRelease(recordId);
    final upload = await _request(
      'POST',
      _uploadEndpoint(''),
      body: jsonEncode({
        'kind': 'release',
        'releaseRecordId': recordId,
        'repository': summary.releaseRecord.repository,
        'commit': summary.releaseRecord.baselineCommit,
        'expectedFiles': files.length,
      }),
    );
    final sessionId = _requiredString(upload, 'sessionId');
    for (final file in files) {
      await _request(
        'POST',
        _uploadEndpoint('/file'),
        body: jsonEncode({
          'kind': 'release',
          'sessionId': sessionId,
          'catalogPath': file.catalogPath,
          'content': file.content,
          'contentHash': sha256.convert(utf8.encode(file.content)).toString(),
        }),
      );
    }
    final response = await _request(
      'POST',
      _uploadEndpoint('/finalize'),
      body: jsonEncode({'kind': 'release', 'sessionId': sessionId}),
    );
    final deliveredFiles = <DeliveryTreeFile>[];
    for (final path in _requiredList(response, 'catalogPaths')) {
      final file = await _request(
        'POST',
        _uploadEndpoint('/download'),
        body: jsonEncode({
          'sessionId': sessionId,
          'catalogPath': _string(path),
        }),
      );
      deliveredFiles.add(
        DeliveryTreeFile(
          catalogPath: _requiredString(file, 'catalogPath'),
          content: _requiredString(file, 'content'),
        ),
      );
    }
    return _decodeResponse(
      () => ReleaseDeliveryTree(
        releaseRecord: _record(_requiredObject(response, 'releaseRecord')),
        files: deliveredFiles,
        applied: _requiredList(
          response,
          'applied',
        ).map((value) => _string(value)).toList(),
        skipped: _requiredList(response, 'skipped').map((value) {
          final skipped = _object(value);
          return SkippedReleaseKey(
            messageId: _requiredString(skipped, 'messageId'),
            reason: _requiredString(skipped, 'reason'),
          );
        }).toList(),
      ),
    );
  }

  ReleaseSummary _summary(Map<String, Object?> response) => ReleaseSummary(
    releaseRecord: _record(_requiredObject(response, 'releaseRecord')),
    catalogs: _requiredList(response, 'catalogs').map((value) {
      final catalog = _object(value);
      return BoundCatalog(
        localeCode: _requiredString(catalog, 'localeCode'),
        catalogPath: _requiredString(catalog, 'catalogPath'),
        isSource: _requiredBool(catalog, 'isSource'),
      );
    }).toList(),
    changeKeyCount: _requiredInt(response, 'changeKeyCount'),
  );

  ReleaseRecordIdentity _record(Map<String, Object?> record) =>
      ReleaseRecordIdentity(
        id: _requiredString(record, 'id'),
        projectId: _requiredString(record, 'projectId'),
        baselineSnapshotId: _requiredString(record, 'baselineSnapshotId'),
        repository: _requiredString(record, 'repository'),
        baselineCommit: _requiredString(record, 'baselineCommit'),
        manifestHash: _requiredString(record, 'manifestHash'),
        integrationBranch: _requiredString(record, 'integrationBranch'),
      );

  Uri _uploadEndpoint(String suffix) {
    final release = _endpoint('');
    return release.replace(
      path: release.path.replaceFirst('/releases/', '/snapshot-uploads$suffix'),
    );
  }

  Uri _endpoint(String suffix) {
    final prefix = baseUrl.path == '/'
        ? ''
        : baseUrl.path.endsWith('/')
        ? baseUrl.path.substring(0, baseUrl.path.length - 1)
        : baseUrl.path;
    return baseUrl.replace(
      path: '$prefix/api/repository-adapter/v1/releases/$suffix',
      queryParameters: const {},
    );
  }

  Future<Map<String, Object?>> _request(
    String method,
    Uri uri, {
    String? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, uri);
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      _compatibility.stamp(request.headers);
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(body);
      }
      final response = await request.close();
      final responseBody = await utf8.decoder.bind(response).join();
      if (response.statusCode != HttpStatus.ok) {
        throw RepositoryAdapterException(
          'Blabla rejected the release request (${response.statusCode}). ${_errorMessage(responseBody)}',
        );
      }
      _compatibility.check(response.headers, onWarning: onWarning);
      try {
        return _object(jsonDecode(responseBody));
      } on FormatException {
        throw RepositoryAdapterException(
          'Blabla returned an invalid existing-locale release response.',
        );
      }
    } on HandshakeException catch (error) {
      throw RepositoryAdapterException(
        'Could not establish a secure connection to Blabla: $error',
      );
    } on SocketException catch (error) {
      throw RepositoryAdapterException(
        'Could not reach Blabla to read the release: ${error.message}',
      );
    } finally {
      client.close(force: true);
    }
  }

  String _errorMessage(String body) {
    try {
      final response = _object(jsonDecode(body));
      final error = response['error'];
      if (error is String && error.isNotEmpty) return error;
      if (error is Map) {
        final message = error['message'];
        if (message is String && message.isNotEmpty) return message;
      }
    } on FormatException {
      // A non-JSON error is safe to summarize by status alone.
    }
    return 'Check the Release Record id and the token export scope.';
  }
}

T _decodeResponse<T>(T Function() decode) {
  try {
    return decode();
  } on FormatException {
    throw RepositoryAdapterException(
      'Blabla returned an invalid existing-locale release response.',
    );
  }
}

Map<String, Object?> _object(Object? value) {
  if (value is! Map) throw const FormatException();
  final result = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String) throw const FormatException();
    result[entry.key as String] = entry.value;
  }
  return result;
}

Map<String, Object?> _requiredObject(Map<String, Object?> object, String key) {
  try {
    return _object(object[key]);
  } on FormatException {
    throw RepositoryAdapterException(
      'Blabla returned an invalid existing-locale release response.',
    );
  }
}

List<Object?> _requiredList(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! List) {
    throw RepositoryAdapterException(
      'Blabla returned an invalid existing-locale release response.',
    );
  }
  return value.cast<Object?>();
}

String _requiredString(Map<String, Object?> object, String key) =>
    _string(object[key]);

String _string(Object? value) {
  if (value is! String) {
    throw RepositoryAdapterException(
      'Blabla returned an invalid existing-locale release response.',
    );
  }
  return value;
}

int _requiredInt(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! int) {
    throw RepositoryAdapterException(
      'Blabla returned an invalid existing-locale release response.',
    );
  }
  return value;
}

bool _requiredBool(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! bool) {
    throw RepositoryAdapterException(
      'Blabla returned an invalid existing-locale release response.',
    );
  }
  return value;
}
