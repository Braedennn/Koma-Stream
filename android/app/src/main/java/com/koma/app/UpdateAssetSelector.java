package com.koma.app;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Chooses the APK belonging to this product flavor from a release's assets. */
final class UpdateAssetSelector {

  private static final Pattern KOMA_APK = Pattern.compile(
      "^[Kk][Oo][Mm][Aa]-(?:[vV]?(\\d+(?:\\.\\d+){1,3})-)?(phone|tv)\\.apk$");

  private UpdateAssetSelector() { }

  static UpdateAsset select(List<UpdateAsset> assets, String flavor, String releaseVersion) {
    if (assets == null || flavor == null) return null;

    // Every APK for this flavor must carry a usable digest. Validate the whole
    // set before choosing one, so an exact-version match cannot hide a second
    // malformed candidate in the same release.
    for (UpdateAsset asset : assets) {
      Matcher match = KOMA_APK.matcher(asset.name.trim());
      if (!match.matches()) continue;
      if (!flavor.equalsIgnoreCase(match.group(2))) continue;
      if (!asset.hasSha256()) {
        throw new IllegalArgumentException(
            "The release APK is missing a valid SHA-256 checksum.");
      }
    }

    UpdateAsset stable = null;
    for (UpdateAsset asset : assets) {
      Matcher match = KOMA_APK.matcher(asset.name.trim());
      if (!match.matches()) continue;
      if (!flavor.equalsIgnoreCase(match.group(2))) continue;

      String assetVersion = match.group(1);
      if (assetVersion == null) {
        if (stable == null) stable = asset;
        continue;
      }
      if (UpdateVersion.compare(assetVersion, releaseVersion) == 0) return asset;
    }
    return stable;
  }
}
