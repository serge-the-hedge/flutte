import 'dart:io';

import 'package:blabla_cli/agent_api_gateway.dart';
import 'package:blabla_cli/cli_version.dart';
import 'package:blabla_cli/credentials.dart';
import 'package:blabla_cli/locale_proposal_adapter.dart';
import 'package:blabla_cli/release_api_gateway.dart';
import 'package:blabla_cli/release_delivery_adapter.dart';
import 'package:blabla_cli/snapshot_sync_adapter.dart';

Future<void> main(List<String> arguments) async {
  exitCode = await runCli(arguments);
}

/// The executable adapter: argument and environment handling only. All locale,
/// Git, and Flutter safety policy remains inside [RepositoryAdapter].
Future<int> runCli(
  List<String> arguments, {
  Map<String, String>? environment,
  void Function(String line)? write,
  void Function(String line)? writeError,
}) async {
  final effectiveEnvironment = environment ?? Platform.environment;
  final output = write ?? (String line) => stdout.writeln(line);
  final errorOutput = writeError ?? (String line) => stderr.writeln(line);
  if (arguments.isEmpty ||
      arguments.contains('--help') ||
      arguments.contains('-h')) {
    output(_usage);
    return arguments.isEmpty ? 1 : 0;
  }
  if (arguments.first != 'deliver-portuguese' &&
      arguments.first != 'deliver' &&
      arguments.first != 'sync') {
    if (arguments.first == 'login') {
      return _login(
        arguments.skip(1).toList(),
        environment: effectiveEnvironment,
        write: output,
      );
    }
    errorOutput('Unknown command: ${arguments.first}');
    errorOutput(_usage);
    return 1;
  }

  if (arguments.first == 'sync') {
    return _sync(
      arguments.skip(1).toList(),
      environment: effectiveEnvironment,
      write: output,
      writeError: errorOutput,
    );
  }

  if (arguments.first == 'deliver') {
    return _deliverRelease(
      arguments.skip(1).toList(),
      environment: effectiveEnvironment,
      write: output,
      writeError: errorOutput,
    );
  }

  try {
    output(
      'Note: deliver-portuguese is a compatibility command. Prefer `blabla deliver --release <id> --locale-proposal <id>` when shipping existing and new Locale work together.',
    );
    final options = _options(arguments.skip(1).toList(), const {
      'checkout',
      'proposal',
      'server',
      'token',
      'flutter-sdk',
    });
    final proposalId = _requiredOption(options, 'proposal');
    final store = CredentialStore();
    BlablaCredentials? storedCredentials;
    Future<BlablaCredentials?> stored() async =>
        storedCredentials ??= await store.read();
    final token =
        options['token'] ??
        effectiveEnvironment['BLABLA_TOKEN'] ??
        (await stored())?.token;
    if (token == null || token.isEmpty) {
      throw RepositoryAdapterException(
        'Set BLABLA_TOKEN or pass --token to read the Portuguese proposal.',
      );
    }
    final serverValue =
        options['server'] ??
        effectiveEnvironment['BLABLA_API_URL'] ??
        (await stored())?.server;
    if (serverValue == null || serverValue.isEmpty) {
      throw RepositoryAdapterException(
        'Set BLABLA_API_URL or pass --server for the Blabla deployment.',
      );
    }
    final server = Uri.tryParse(serverValue);
    if (server == null ||
        !server.hasScheme ||
        !{'http', 'https'}.contains(server.scheme)) {
      throw RepositoryAdapterException(
        '--server must be an http or https URL.',
      );
    }
    final checkout = Directory(options['checkout'] ?? Directory.current.path);
    final flutter = await FlutterToolchainResolver(
      environment: effectiveEnvironment,
    ).resolve(checkout, explicitSdk: options['flutter-sdk']);
    output('Blabla CLI $blablaCliVersion. ${flutter.description}');
    final gateway = HttpLocaleProposalGateway(
      baseUrl: server,
      token: token,
      onWarning: output,
    );
    await RepositoryAdapter().deliver(
      DeliveryRequest(
        checkout: checkout,
        proposalId: proposalId,
        flutter: flutter,
        gateway: gateway,
        write: output,
      ),
    );
    return 0;
  } on RepositoryAdapterException catch (error) {
    errorOutput(error.message);
    return 1;
  }
}

Future<int> _deliverRelease(
  List<String> arguments, {
  required Map<String, String> environment,
  required void Function(String line) write,
  required void Function(String line) writeError,
}) async {
  try {
    final options = _options(arguments, const {
      'checkout',
      'release',
      'locale-proposal',
      'server',
      'token',
      'flutter-sdk',
    });
    final recordId = _requiredOption(options, 'release');
    final localeProposalId = options['locale-proposal'];
    final store = CredentialStore();
    BlablaCredentials? storedCredentials;
    Future<BlablaCredentials?> stored() async =>
        storedCredentials ??= await store.read();
    final token =
        options['token'] ??
        environment['BLABLA_TOKEN'] ??
        (await stored())?.token;
    if (token == null || token.isEmpty) {
      throw RepositoryAdapterException(
        'Set BLABLA_TOKEN or pass --token to read the Release Bundle.',
      );
    }
    final serverValue =
        options['server'] ??
        environment['BLABLA_API_URL'] ??
        (await stored())?.server;
    if (serverValue == null || serverValue.isEmpty) {
      throw RepositoryAdapterException(
        'Set BLABLA_API_URL or pass --server for the Blabla deployment.',
      );
    }
    final server = Uri.tryParse(serverValue);
    if (server == null ||
        !server.hasScheme ||
        !{'http', 'https'}.contains(server.scheme)) {
      throw RepositoryAdapterException(
        '--server must be an http or https URL.',
      );
    }
    final checkout = Directory(options['checkout'] ?? Directory.current.path);
    final flutter = await FlutterToolchainResolver(
      environment: environment,
    ).resolve(checkout, explicitSdk: options['flutter-sdk']);
    write('Blabla CLI $blablaCliVersion. ${flutter.description}');
    await ReleaseRepositoryAdapter().deliver(
      ReleaseDeliveryRequest(
        checkout: checkout,
        recordId: recordId,
        flutter: flutter,
        gateway: HttpReleaseGateway(
          baseUrl: server,
          token: token,
          onWarning: write,
        ),
        localeProposal: localeProposalId == null
            ? null
            : LocaleProposalDeliveryInput(
                proposalId: localeProposalId,
                gateway: HttpLocaleProposalGateway(
                  baseUrl: server,
                  token: token,
                  onWarning: write,
                ),
              ),
        write: write,
      ),
    );
    return 0;
  } on RepositoryAdapterException catch (error) {
    writeError(error.message);
    return 1;
  }
}

Future<int> _sync(
  List<String> arguments, {
  required Map<String, String> environment,
  required void Function(String line) write,
  required void Function(String line) writeError,
}) async {
  try {
    final options = _options(arguments, const {'checkout', 'server', 'token'});
    final store = CredentialStore();
    BlablaCredentials? storedCredentials;
    Future<BlablaCredentials?> stored() async =>
        storedCredentials ??= await store.read();
    final token =
        options['token'] ??
        environment['BLABLA_TOKEN'] ??
        (await stored())?.token;
    if (token == null || token.isEmpty) {
      throw RepositoryAdapterException(
        'Set BLABLA_TOKEN or pass --token to sync the Brickit checkout.',
      );
    }
    final serverValue =
        options['server'] ??
        environment['BLABLA_API_URL'] ??
        (await stored())?.server;
    if (serverValue == null || serverValue.isEmpty) {
      throw RepositoryAdapterException(
        'Set BLABLA_API_URL or pass --server for the Blabla deployment.',
      );
    }
    final server = Uri.tryParse(serverValue);
    if (server == null ||
        !server.hasScheme ||
        !{'http', 'https'}.contains(server.scheme)) {
      throw RepositoryAdapterException(
        '--server must be an http or https URL.',
      );
    }
    final checkout = Directory(options['checkout'] ?? Directory.current.path);
    final gateway = HttpSnapshotSyncGateway(
      baseUrl: server,
      token: token,
      onWarning: write,
    );
    final receipt = await RepositorySyncAdapter().sync(
      checkout: checkout,
      gateway: gateway,
      write: write,
    );
    return receipt.succeeded ? 0 : 1;
  } on RepositoryAdapterException catch (error) {
    writeError(error.message);
    return 1;
  }
}

Future<int> _login(
  List<String> arguments, {
  required Map<String, String> environment,
  required void Function(String line) write,
}) async {
  try {
    final options = _options(arguments, const {'server', 'token'});
    final token = options['token'] ?? environment['BLABLA_TOKEN'];
    final server = options['server'] ?? environment['BLABLA_API_URL'];
    if (token == null || token.isEmpty || server == null || server.isEmpty) {
      throw RepositoryAdapterException(
        'Login needs --server and --token, or BLABLA_API_URL and BLABLA_TOKEN.',
      );
    }
    final store = CredentialStore();
    await store.write(BlablaCredentials(server: server, token: token));
    write('Stored Blabla credentials at ${store.file.path}.');
    return 0;
  } on RepositoryAdapterException catch (error) {
    write(error.message);
    return 1;
  }
}

Map<String, String> _options(List<String> arguments, Set<String> supported) {
  final options = <String, String>{};
  for (var index = 0; index < arguments.length; index += 2) {
    final flag = arguments[index];
    if (!flag.startsWith('--') || flag.length == 2) {
      throw RepositoryAdapterException(
        'Expected a named option, received $flag.',
      );
    }
    final key = flag.substring(2);
    if (!supported.contains(key)) {
      throw RepositoryAdapterException('Unknown option: $flag.');
    }
    if (options.containsKey(key)) {
      throw RepositoryAdapterException(
        'Option $flag was supplied more than once.',
      );
    }
    if (index + 1 >= arguments.length ||
        arguments[index + 1].startsWith('--')) {
      throw RepositoryAdapterException('Option $flag needs a value.');
    }
    options[key] = arguments[index + 1];
  }
  return options;
}

String _requiredOption(Map<String, String> options, String key) {
  final value = options[key];
  if (value == null || value.isEmpty) {
    throw RepositoryAdapterException('--$key is required.');
  }
  return value;
}

const _usage = '''Usage:
  blabla sync [options]
  blabla deliver --release <release-record-id> [--locale-proposal <proposal-id>] [options]
  blabla deliver-portuguese --proposal <proposal-id> [options]
  blabla login --server <url> --token <token>

Options:
  sync                 Read bound ARB files and submit one durable snapshot
  --checkout <path>  Brickit checkout (defaults to the current directory)
  --server <url>     Blabla deployment (or BLABLA_API_URL)
  --token <token>    Workspace token (or BLABLA_TOKEN)
  --flutter-sdk <path>
                     Flutter SDK directory (or FLUTTER_ROOT / .fvm/flutter_sdk
                     / .fvmrc through fvm / flutter on PATH)

`deliver` applies a reviewed existing-locale Release Bundle, runs Flutter
generation in a disposable worktree, and creates one local review commit. Add
`--locale-proposal` to include a ready new Locale in that same commit.
Commands never push or open a pull request.''';
