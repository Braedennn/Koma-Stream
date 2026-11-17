package com.koma.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** The parts of GitHub's latest-release response that the updater needs. */
final class GitHubRelease {

  final String tag;
  final String version;
  final String notes;
  final List<UpdateAsset> assets;

  private GitHubRelease(String tag, String version, String notes, List<UpdateAsset> assets) {
    this.tag = tag;
    this.version = version;
    this.notes = notes;
    this.assets = assets;
  }

  static GitHubRelease fromJson(String json) throws Exception {
    JSONObject root = new JSONObject(json);
    String tag = root.optString("tag_name", "").trim();
    String version = UpdateVersion.canonical(tag);
    if (version.isEmpty()) throw new IllegalArgumentException("release tag is not a version");

    List<UpdateAsset> assets = new ArrayList<>();
    JSONArray assetArray = root.optJSONArray("assets");
    if (assetArray != null) {
      for (int i = 0; i < assetArray.length(); i++) {
        JSONObject item = assetArray.optJSONObject(i);
        if (item == null) continue;
        String name = item.optString("name", "").trim();
        String url = item.optString("browser_download_url", "").trim();
        if (name.isEmpty() || url.isEmpty()) continue;
        long size = item.optLong("size", 0L);
        String digest = item.optString("digest", "").trim();
        assets.add(new UpdateAsset(name, url, size, digest));
      }
    }

    String notes = root.optString("body", "").trim();
    return new GitHubRelease(tag, version, notes, assets);
  }
}
