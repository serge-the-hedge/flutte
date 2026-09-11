import 'dart:async';
import 'dart:convert';
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
  Future<String> Function(bool fromStdin)? readToken,
}) async {
  final effectiveEnvironment = environment ?? Platform.environment;
  final output = write ?? (String line) => stdout.writeln(line);
  final errorOutput = writeError ?? (String line) => stderr.writeln(line);
  if (arguments.length == 1 && arguments.single == '--version') {
    output('blabla $blablaCliVersion (protocol $blablaCliProtocol)');
    return 0;
  }
  if (arguments.isEmpty ||
      arguments.contains('--help') ||
      arguments.contains('-h')) {
    output(_usage);
    return arguments.isEmpty ? 1 : 0;
  }
  if (arguments.first == 'profiles' || arguments.first == 'logout') {
    try {
      final store = CredentialStore.forEnvironment(effectiveEnvironment);
      if (arguments.first == 'profiles') {
        _options(arguments.skip(1).toList(), const {});
        for (final name in await store.listProfiles()) output(name);
      } else {
        final options = _options(arguments.skip(1).toList(), const {'profile'});
        await store.removeProfile(_requiredOption(options, 'profile'));
        output('Removed local profile. The server token has not been revoked.');
      }
      return 0;
    } on RepositoryAdapterException catch (error) {
      errorOutput(error.message);
      return 1;
    } on FileSystemException {
      errorOutput(
        'Could not access credential profiles. Check local permissions.',
      );
      return 1;
    }
  }
  if (arguments.first != 'deliver-locale' &&
      arguments.first != 'deliver-portuguese' &&
      arguments.first != 'deliver' &&
      arguments.first != 'sync') {
    if (arguments.first == 'login') {
      return _login(
        arguments.skip(1).toList(),
        environment: effectiveEnvironment,
        write: output,
        writeError: errorOutput,
        readToken: readToken ?? _readToken,
      );
    }
    errorOutput('Unknown command. Run blabla --help for usage.');
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
    if (arguments.first == 'deliver-portuguese') {
      output(
        'Note: deliver-portuguese is deprecated. Use `blabla deliver-locale --proposal <id>`.',
      );
    }
    final options = _options(arguments.skip(1).toList(), const {
      'checkout',
      'proposal',
      'server',
      'token',
      'profile',
      'flutter-sdk',
    });
    final proposalId = _requiredOption(options, 'proposal');
    final credentials = await resolveCredentials(
      options: options,
      environment: effectiveEnvironment,
    );
    final server = Uri.parse(credentials.server);
    final token = credentials.token;
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
      'profile',
      'flutter-sdk',
    });
    final recordId = _requiredOption(options, 'release');
    final localeProposalId = options['locale-proposal'];
    final credentials = await resolveCredentials(
      options: options,
      environment: environment,
    );
    final server = Uri.parse(credentials.server);
    final token = credentials.token;
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
    final options = _options(arguments, const {
      'checkout',
      'server',
      'token',
      'profile',
    });
    final credentials = await resolveCredentials(
      options: options,
      environment: environment,
    );
    final server = Uri.parse(credentials.server);
    final token = credentials.token;
    final checkout = Directory(options['checkout'] ?? Directory.current.path);
    final gateway = HttpSnapshotSyncGateway(
      baseUrl: server,
      token: token,
      onWarning: writeError,
      onProgress: writeError,
    );
    final receipt = await RepositorySyncAdapter().sync(
      checkout: checkout,
      gateway: gateway,
      write: write,
      onProgress: writeError,
      writeError: writeError,
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
  required void Function(String line) writeError,
  required Future<String> Function(bool fromStdin) readToken,
}) async {
  try {
    final options = _options(
      arguments,
      const {'server', 'token', 'profile', 'token-stdin', 'replace'},
      booleanFlags: const {'token-stdin', 'replace'},
    );
    final explicitServer = options['server'];
    final explicitToken = options['token'];
    final canonical =
        environment.containsKey('BLABLA_API_URL') ||
        environment.containsKey('BLABLA_TOKEN');
    final legacy =
        environment.containsKey('BLABLA_AGENT_URL') ||
        environment.containsKey('BLABLA_AGENT_TOKEN');
    if (canonical && legacy)
      throw RepositoryAdapterException(
        'Use only one environment credential pair.',
      );
    final ambientToken = canonical
        ? environment['BLABLA_TOKEN']
        : environment['BLABLA_AGENT_TOKEN'];
    if (explicitServer != null && explicitToken == null && ambientToken != null)
      throw RepositoryAdapterException(
        'Unset inherited token environment variables to enter a token securely, or supply both --server and --token explicitly.',
      );
    if (explicitToken != null && explicitServer == null)
      throw RepositoryAdapterException(
        '--token requires --server; do not mix flag and environment credentials.',
      );
    final server =
        explicitServer ??
        (canonical
            ? environment['BLABLA_API_URL']
            : environment['BLABLA_AGENT_URL']);
    if (server == null)
      throw RepositoryAdapterException(
        'Login requires --server or a complete credential environment pair.',
      );
    final profile = options['profile'] ?? environment['BLABLA_PROFILE'];
    final store = CredentialStore.forEnvironment(environment);
    if (profile != null) store.profileFile(profile);
    var token = explicitToken ?? (explicitServer == null ? ambientToken : null);
    if (options.containsKey('token-stdin') && token != null) {
      throw RepositoryAdapterException(
        '--token-stdin cannot be combined with --token or token environment variables.',
      );
    }
    // Check the destination before prompting for a secret.
    BlablaCredentials(server: server, token: 'validation').validated();
    token ??= await readToken(options.containsKey('token-stdin'));
    await store.write(
      BlablaCredentials(server: server, token: token),
      profile: profile,
      replace: options.containsKey('replace'),
    );
    write(
      profile == null
          ? 'Stored Blabla credentials.'
          : 'Stored profile "$profile".',
    );
    return 0;
  } on RepositoryAdapterException catch (error) {
    writeError(error.message);
    return 1;
  }
}

Future<String> _readToken(bool fromStdin) async {
  if (fromStdin) {
    final bytes = <int>[];
    await for (final chunk in stdin) {
      bytes.addAll(chunk);
      if (bytes.length > 8194)
        throw RepositoryAdapterException('The token input is too long.');
    }
    try {
      return utf8.decode(bytes).replaceFirst(RegExp(r'\r?\n$'), '');
    } on FormatException {
      throw RepositoryAdapterException('The token must be valid UTF-8 text.');
    }
  }
  if (!stdin.hasTerminal) {
    throw RepositoryAdapterException(
      'Login needs a terminal to hide token input. Use --token-stdin for automation.',
    );
  }
  final echo = stdin.echoMode;
  final input = Completer<String>();
  final bytes = <int>[];
  final signals = <StreamSubscription<ProcessSignal>>[];
  StreamSubscription<List<int>>? subscription;
  void fail(String message) {
    if (!input.isCompleted) {
      input.completeError(RepositoryAdapterException(message));
    }
  }

  void finish() {
    if (input.isCompleted) return;
    try {
      input.complete(utf8.decode(bytes).replaceFirst(RegExp(r'\r$'), ''));
    } on FormatException {
      fail('The token must be valid UTF-8 text.');
    }
  }

  try {
    // Keep the event loop available so interruption restores terminal echo.
    for (final signal in [ProcessSignal.sigint, ProcessSignal.sigterm]) {
      signals.add(signal.watch().listen((_) => fail('Token entry cancelled.')));
    }
    stdin.echoMode = false;
    stderr.write('Token: ');
    subscription = stdin.listen(
      (chunk) {
        if (input.isCompleted) return;
        final newline = chunk.indexOf(10);
        bytes.addAll(newline < 0 ? chunk : chunk.take(newline));
        if (bytes.length > 8194) {
          fail('The token input is too long.');
        } else if (newline >= 0) {
          finish();
        }
      },
      onDone: finish,
      onError: (Object _) {
        fail('Could not read the token securely from this terminal.');
      },
    );
    return await input.future;
  } on StdinException {
    throw RepositoryAdapterException(
      'Could not read the token securely from this terminal.',
    );
  } finally {
    stdin.echoMode = echo;
    stderr.writeln();
    await subscription?.cancel();
    for (final signal in signals) {
      await signal.cancel();
    }
  }
}

Map<String, String> _options(
  List<String> arguments,
  Set<String> supported, {
  Set<String> booleanFlags = const {},
}) {
  final options = <String, String>{};
  for (var index = 0; index < arguments.length; index++) {
    final flag = arguments[index];
    if (!flag.startsWith('--') || flag.length == 2) {
      throw RepositoryAdapterException(
        'Expected a named option. Run blabla --help for usage.',
      );
    }
    final key = flag.substring(2);
    if (!supported.contains(key)) {
      throw RepositoryAdapterException(
        'Unknown option. Run blabla --help for usage.',
      );
    }
    if (options.containsKey(key)) {
      throw RepositoryAdapterException(
        'Option $flag was supplied more than once.',
      );
    }
    if (booleanFlags.contains(key)) {
      options[key] = 'true';
      continue;
    }
    if (index + 1 >= arguments.length ||
        arguments[index + 1].startsWith('--')) {
      throw RepositoryAdapterException('Option $flag needs a value.');
    }
    options[key] = arguments[++index];
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
  blabla --version
  blabla sync [options]
  blabla deliver --release <release-record-id> [--locale-proposal <proposal-id>] [options]
  blabla deliver-locale --proposal <proposal-id> [options]
  blabla login --profile <name> --server <url> [--token-stdin] [--replace]
  blabla profiles
  blabla logout --profile <name>

Options:
  sync                 Read bound ARB files and submit one durable snapshot
  --checkout <path>  Brickit checkout (defaults to the current directory)
  --server <url>     Blabla deployment (or BLABLA_API_URL)
  --token <token>    Token (or BLABLA_TOKEN); login prefers hidden input
  --profile <name>   Named credentials (or BLABLA_PROFILE), without server/token overrides
  --flutter-sdk <path>
                     Flutter SDK directory (otherwise repository FVM, then
                     FLUTTER_ROOT, then flutter on PATH)

`deliver` applies a reviewed existing-locale Release Bundle, runs Flutter
generation in a disposable worktree, and creates a local review branch. Add
`--locale-proposal` to include a ready new Locale in the delivery commit. A
verified refresh of existing generated locale files gets a separate preceding
commit on that branch.
Commands never push or open a pull request.''';
