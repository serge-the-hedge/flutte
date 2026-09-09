import 'dart:convert';
import 'dart:io';

import 'package:blabla_cli/agent_api_gateway.dart';
import 'package:blabla_cli/command_runner.dart';
import 'package:blabla_cli/release_api_gateway.dart';
import 'package:blabla_cli/snapshot_sync_adapter.dart';
import 'package:test/test.dart';

void main() {
  const token = 'secret-fixture';
  final gateways =
      <String, Future<Object?> Function(Uri, void Function(String))>{
        'locale': (url, warning) => HttpLocaleProposalGateway(
          baseUrl: url,
          token: token,
          onWarning: warning,
        ).readProposal('proposal'),
        'release': (url, warning) => HttpReleaseGateway(
          baseUrl: url,
          token: token,
          onWarning: warning,
        ).readRelease('release'),
        'snapshot': (url, warning) => HttpSnapshotSyncGateway(
          baseUrl: url,
          token: token,
          onWarning: warning,
        ).readContext(),
      };
  for (final gateway in gateways.entries) {
    test('${gateway.key} refuses authenticated redirects', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final seen = <String>[];
      server.listen((request) async {
        seen.add(request.uri.path);
        request.response.statusCode = HttpStatus.found;
        request.response.headers.set(HttpHeaders.locationHeader, '/redirected');
        await request.response.close();
      });
      await expectLater(
        gateway.value(Uri.parse('http://127.0.0.1:${server.port}'), (_) {}),
        throwsA(isA<RepositoryAdapterException>()),
      );
      expect(seen, hasLength(1));
      expect(seen, isNot(contains('/redirected')));
    });
    for (final nested in [false, true]) {
      test(
        '${gateway.key} redacts ${nested ? 'nested' : 'string'} API error tokens',
        () async {
          final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
          addTearDown(() => server.close(force: true));
          server.listen((request) async {
            request.response.statusCode = HttpStatus.forbidden;
            request.response.write(
              jsonEncode({
                'error': nested
                    ? {'message': 'Rejected $token'}
                    : 'Rejected $token',
              }),
            );
            await request.response.close();
          });
          await expectLater(
            gateway.value(Uri.parse('http://127.0.0.1:${server.port}'), (_) {}),
            throwsA(
              isA<RepositoryAdapterException>().having(
                (error) => error.message,
                'message',
                allOf(contains('[REDACTED]'), isNot(contains(token))),
              ),
            ),
          );
        },
      );
    }
    test(
      '${gateway.key} redacts credentials in compatibility warnings',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => server.close(force: true));
        final warnings = <String>[];
        server.listen((request) async {
          request.response.headers.set(
            'X-Blabla-Minimum-CLI-Version',
            '999.0.0+$token',
          );
          request.response.write('{}');
          await request.response.close();
        });
        // Incomplete fixture response is rejected after processing headers.
        await expectLater(
          gateway.value(
            Uri.parse('http://127.0.0.1:${server.port}'),
            warnings.add,
          ),
          throwsException,
        );
        expect(warnings.single, contains('[REDACTED]'));
        expect(warnings.single, isNot(contains(token)));
      },
    );
  }
}
