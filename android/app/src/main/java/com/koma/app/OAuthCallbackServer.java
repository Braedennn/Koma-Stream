package com.koma.app;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;

final class OAuthCallbackServer {

  private ServerSocket server;
  private Thread worker;

  static OAuthCallbackServer start(int port) {
    OAuthCallbackServer listener = new OAuthCallbackServer();
    try {
      listener.server = new ServerSocket();
      listener.server.setReuseAddress(true);
      listener.server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
      listener.server.setSoTimeout(15 * 60 * 1000);
    } catch (Exception error) {
      listener.stop();
      return null;
    }
    listener.worker = new Thread(listener::acceptLoop, "Koma OAuth callback");
    listener.worker.setDaemon(true);
    listener.worker.start();
    return listener;
  }

  void stop() {
    ServerSocket open = server;
    server = null;
    if (open != null) {
      try { open.close(); } catch (Exception ignored) { }
    }
  }

  private void acceptLoop() {
    while (server != null) {
      try (Socket socket = server.accept()) {
        handle(socket);
      } catch (Exception ignored) {
        if (server != null) continue;
        return;
      }
    }
  }

  private void handle(Socket socket) throws Exception {
    socket.setSoTimeout(5000);
    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
    String request = reader.readLine();
    if (request == null) return;

    String[] parts = request.split(" ");
    if (parts.length < 2 || !"GET".equalsIgnoreCase(parts[0])) {
      respond(socket, 405, null);
      return;
    }

    URI target;
    try {
      target = URI.create(parts[1]);
    } catch (Exception error) {
      respond(socket, 400, null);
      return;
    }
    String path = target.getRawPath();
    String provider = "";
    if ("/auth/anilist".equals(path)) provider = "anilist";
    else if ("/auth/myanimelist".equals(path)) provider = "myanimelist";
    if (provider.isEmpty()) {
      respond(socket, 404, null);
      return;
    }

    String query = target.getRawQuery();
    String appUri = BuildConfig.APPLICATION_ID + "://auth/" + provider;
    if (query != null && !query.isEmpty()) appUri += "?" + query;
    respond(socket, 302, appUri);
    stop();
  }

  private static void respond(Socket socket, int status, String location) throws Exception {
    String reason = status == 302 ? "Found" : status == 404 ? "Not Found" : status == 400 ? "Bad Request" : "Method Not Allowed";
    StringBuilder response = new StringBuilder();
    response.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
    if (location != null) response.append("Location: ").append(location).append("\r\n");
    response.append("Content-Length: 0\r\n");
    response.append("Connection: close\r\n");
    response.append("Cache-Control: no-store\r\n\r\n");
    OutputStream output = socket.getOutputStream();
    output.write(response.toString().getBytes(StandardCharsets.US_ASCII));
    output.flush();
  }
}
