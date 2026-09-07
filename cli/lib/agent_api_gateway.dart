import 'dart:convert';
import 'dart:io';

import 'cli_version.dart';
import 'locale_proposal_adapter.dart';
import 'repository_policy.dart';

/// The thin HTTP adapter for the existing Agent API. It fetches only the
/// server-authored review state and immutable artifact; it has no Git access
/// and cannot alter a proposal.
class HttpLocaleProposalGateway implements LocaleProposalGateway {
  HttpLocaleProposalGateway({
    required this.baseUrl,
    required this.token,
    this.onWarning,
  });

  final Uri baseUrl;
  final String token;
  final void Function(String line)? onWarning;
  final _compatibility = CliCompatibility();

  @override
  Future<LocaleProposalSummary> readProposal(String proposalId) async {
    final response = await _get(_endpoint('', proposalId));
    return LocaleProposalSummary(
      proposalId: _requiredString(response, 'proposalId'),
      sourceSnapshotId: _requiredString(response, 'sourceSnapshotId'),
      status: _requiredString(response, 'status'),
      deliveryStatus: _requiredString(response, 'deliveryStatus'),
    );
  }

  @override
  Future<LocaleProposalArtifact> readArtifact(String proposalId) async {
    final response = await _get(_endpoint('/artifact', proposalId));
    final source = _requiredObject(response, 'sourceSnapshot');
    final locale = _requiredObject(response, 'locale');
    final catalog = _requiredObject(response, 'catalog');
    return LocaleProposalArtifact(
      version: _requiredInt(response, 'version'),
      proposalId: _requiredString(response, 'proposalId'),
      sourceSnapshot: SourceSnapshotIdentity(
        id: _requiredString(source, 'id'),
        repository: _requiredString(source, 'repository'),
        commit: _requiredString(source, 'commit'),
        manifestHash: _requiredString(source, 'manifestHash'),
        catalogPath: _requiredString(source, 'catalogPath'),
        integrationBranch:
            _optionalString(source, 'integrationBranch') ??
            defaultIntegrationBranch,
      ),
      locale: ProposedLocale(
        code: _requiredString(locale, 'code'),
        label: _requiredString(locale, 'label'),
        runtimeLocale: _requiredString(locale, 'runtimeLocale'),
      ),
      catalog: ProposedCatalog(
        fileName: _requiredString(catalog, 'fileName'),
        content: _requiredString(catalog, 'content'),
        contentHash: _requiredString(catalog, 'contentHash'),
      ),
    );
  }

  Uri _endpoint(String suffix, String proposalId) {
    final prefix = baseUrl.path == '/'
        ? ''
        : baseUrl.path.endsWith('/')
        ? baseUrl.path.substring(0, baseUrl.path.length - 1)
        : baseUrl.path;
    return baseUrl.replace(
      path: '$prefix/api/agent/v1/locale-proposals/pt$suffix',
      queryParameters: {'proposalId': proposalId},
    );
  }

  Future<Map<String, Object?>> _get(Uri uri) async {
    final client = HttpClient();
    try {
      final request = await client.getUrl(uri);
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      _compatibility.stamp(request.headers);
      final response = await request.close();
      final body = await utf8.decoder.bind(response).join();
      if (response.statusCode != HttpStatus.ok) {
        throw RepositoryAdapterException(
          'Blabla rejected the Portuguese proposal request (${response.statusCode}). ${_errorMessage(body)}',
        );
      }
      _compatibility.check(response.headers, onWarning: onWarning);
      try {
        return _object(jsonDecode(body));
      } on FormatException {
        throw RepositoryAdapterException(
          'Blabla returned an invalid Portuguese proposal response.',
        );
      }
    } on SocketException catch (error) {
      throw RepositoryAdapterException(
        'Could not reach Blabla to read the Portuguese proposal: ${error.message}',
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
      // A non-JSON error is still safe to summarize by status alone.
    }
    return 'Check the proposal id and the token scopes.';
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
  final value = object[key];
  try {
    return _object(value);
  } on FormatException {
    throw RepositoryAdapterException(
      'Blabla returned an invalid Portuguese proposal response.',
    );
  }
}

String _requiredString(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! String) {
    throw RepositoryAdapterException(
      'Blabla returned an invalid Portuguese proposal response.',
    );
  }
  return value;
}

String? _optionalString(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value == null) return null;
  if (value is! String) {
    throw RepositoryAdapterException(
      'Blabla returned an invalid Portuguese proposal response.',
    );
  }
  return value;
}

int _requiredInt(Map<String, Object?> object, String key) {
  final value = object[key];
  if (value is! int) {
    throw RepositoryAdapterException(
      'Blabla returned an invalid Portuguese proposal response.',
    );
  }
  return value;
}
