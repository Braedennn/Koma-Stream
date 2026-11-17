package com.koma.app;

/** One downloadable file attached to a GitHub release. */
final class UpdateAsset {

  final String name;
  final String url;
  final long size;
  final String digest;

  UpdateAsset(String name, String url, long size, String digest) {
    this.name = name == null ? "" : name;
    this.url = url == null ? "" : url;
    this.size = size;
    this.digest = digest == null ? "" : digest;
  }
}
