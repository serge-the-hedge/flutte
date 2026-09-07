import 'dart:convert';
import 'dart:io';

import 'package:blabla_cli/agent_api_gateway.dart';
import 'package:blabla_cli/cli_version.dart';
import 'package:blabla_cli/locale_proposal_adapter.dart';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';

void main() {
  test(
    'reads the current configured Locale proposal and its artifact with a bearer token',
    () async {
      const proposalId = 'proposal_it_123';
      const token = 'agent-token';
      const catalog = '{"@@locale":"it","welcome":"Olá"}';
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      final seenPaths = <String>[];
      final warnings = <String>[];
      server.listen((request) async {
        expect(
          request.headers.value(HttpHeaders.authorizationHeader),
          'Bearer $token',
        );
        seenPaths.add(request.uri.path);
        expect(request.uri.queryParameters['proposalId'], proposalId);
        expect(request.headers.value('x-blabla-cli-version'), blablaCliVersion);
        expect(
          request.headers.value('x-blabla-cli-protocol'),
          '$blablaCliProtocol',
        );
        request.response.headers.contentType = ContentType.json;
        request.response.headers.set('X-Blabla-Minimum-CLI-Version', '0.2.0');
        switch (request.uri.path) {
          case '/api/agent/v1/locale-proposals':
            request.response.write(
              jsonEncode({
                'proposalId': proposalId,
                'sourceSnapshotId': 'snapshot_123',
                'status': 'ready',
                'deliveryStatus': 'ready',
              }),
            );
          case '/api/agent/v1/locale-proposals/artifact':
            request.response.write(
              jsonEncode({
                'version': 1,
                'proposalId': proposalId,
                'sourceSnapshot': {
                  'id': 'snapshot_123',
                  'repository': 'github.com/brickit-app/brickit-flutter',
                  'integrationBranch': 'develop',
                  'commit': List.filled(40, 'a').join(),
                  'manifestHash': List.filled(64, 'b').join(),
                  'catalogPath':
                      'packages/brickit_generated/lib/l10n/intl_en.arb',
                },
                'locale': {
                  'code': 'it',
                  'label': 'Italian',
                  'runtimeLocale': 'it-IT',
                },
                'catalog': {
                  'fileName': 'intl_it.arb',
                  'catalogPath':
                      'packages/brickit_generated/lib/l10n/intl_it.arb',
                  'content': catalog,
                  'contentHash': sha256
                      .convert(utf8.encode(catalog))
                      .toString(),
                },
              }),
            );
        }
        await request.response.close();
      });

      final gateway = HttpLocaleProposalGateway(
        baseUrl: Uri.parse('http://${server.address.address}:${server.port}'),
        token: token,
        onWarning: warnings.add,
      );

      final summary = await gateway.readProposal(proposalId);
      final artifact = await gateway.readArtifact(proposalId);

      expect(summary.status, 'ready');
      expect(summary.deliveryStatus, 'ready');
      expect(artifact.catalog.content, catalog);
      expect(
        artifact.catalog.catalogPath,
        'packages/brickit_generated/lib/l10n/intl_it.arb',
      );
      expect(artifact.sourceSnapshot.integrationBranch, 'develop');
      expect(
        seenPaths,
        equals([
          '/api/agent/v1/locale-proposals',
          '/api/agent/v1/locale-proposals/artifact',
        ]),
      );
      expect(warnings, hasLength(1));
      expect(warnings.single, contains('0.2.0'));
    },
  );

  test('refuses a server-required incompatible protocol', () async {
    const proposalId = 'proposal_it_123';
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    server.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.headers.set('X-Blabla-Minimum-CLI-Protocol', '2');
      request.response.write(
        jsonEncode({
          'proposalId': proposalId,
          'sourceSnapshotId': 'snapshot_123',
          'status': 'ready',
          'deliveryStatus': 'ready',
        }),
      );
      await request.response.close();
    });

    final gateway = HttpLocaleProposalGateway(
      baseUrl: Uri.parse('http://${server.address.address}:${server.port}'),
      token: 'agent-token',
    );

    await expectLater(
      gateway.readProposal(proposalId),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          contains('requires CLI protocol 2'),
        ),
      ),
    );
  });

  test('keeps the server upgrade instruction from a 426 response', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    server.listen((request) async {
      request.response.statusCode = 426;
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'error': 'Blabla requires CLI protocol 2. Install a compatible CLI.',
          'code': 'CLI_UPGRADE_REQUIRED',
        }),
      );
      await request.response.close();
    });

    final gateway = HttpLocaleProposalGateway(
      baseUrl: Uri.parse('http://${server.address.address}:${server.port}'),
      token: 'agent-token',
    );

    await expectLater(
      gateway.readProposal('proposal_it_123'),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          contains('Install a compatible CLI'),
        ),
      ),
    );
  });
}
