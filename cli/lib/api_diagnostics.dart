import 'dart:convert';

/// Server diagnostics are untrusted and may echo the request credential.
String redactApiToken(String message, String token) =>
    token.isEmpty ? message : message.replaceAll(token, '[REDACTED]');

String apiErrorMessage(
  String body, {
  required String token,
  required String fallback,
}) {
  try {
    final response = jsonDecode(body);
    if (response is Map) {
      final error = response['error'];
      final message = error is Map ? error['message'] : error;
      if (message is String && message.isNotEmpty) {
        return redactApiToken(message, token);
      }
    }
  } on FormatException {
    // Proxy HTML and malformed responses are summarized by status alone.
  }
  return fallback;
}
