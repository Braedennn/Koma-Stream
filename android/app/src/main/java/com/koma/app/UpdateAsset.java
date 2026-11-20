package com.koma.app;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** One downloadable file attached to a GitHub release. */
final class UpdateAsset {

  private static final Pattern SHA256 = Pattern.compile("^sha256:([0-9a-fA-F]{64})$");

  final String name;
  final String url;
  final long size;
  final String sha256;

  UpdateAsset(String name, String url, long size, String digest) {
    this.name = name == null ? "" : name;
    this.url = url == null ? "" : url;
    this.size = size;

    String raw = digest == null ? "" : digest.trim();
    Matcher match = SHA256.matcher(raw);
    this.sha256 = match.matches()
        ? match.group(1).toLowerCase(Locale.US) : "";
  }

  boolean hasSha256() {
    return !sha256.isEmpty();
  }
}
