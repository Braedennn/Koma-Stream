package com.koma.app;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import java.io.File;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Set;
import java.util.TreeSet;

/** Checks an APK's identity, version and signer before Android is allowed to install it. */
final class ApkValidator {

  static final class Result {
    final boolean valid;
    final String message;

    private Result(boolean valid, String message) {
      this.valid = valid;
      this.message = message;
    }

    static Result valid() {
      return new Result(true, "");
    }

    static Result invalid(String message) {
      return new Result(false, message);
    }
  }

  private ApkValidator() { }

  static Result validate(Context context, File apk, String expectedPackage) {
    return validate(context, apk, expectedPackage, null);
  }

  static Result validate(Context context, File apk, String expectedPackage, String expectedVersion) {
    PackageManager manager = context.getPackageManager();
    int flags = signingFlags();
    try {
      PackageInfo installed = manager.getPackageInfo(expectedPackage, flags);
      PackageInfo candidate = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
      if (candidate == null) {
        return Result.invalid("The downloaded update could not be read.");
      }
      if (!expectedPackage.equals(candidate.packageName)) {
        return Result.invalid("The downloaded APK is for a different app.");
      }
      if (expectedVersion != null && !expectedVersion.isEmpty()
          && !expectedVersion.equals(UpdateVersion.canonical(candidate.versionName))) {
        return Result.invalid("The downloaded APK is for a different version.");
      }
      if (versionCode(candidate) <= versionCode(installed)) {
        return Result.invalid("The downloaded APK is not a newer version.");
      }
      if (!sameSigner(installed, candidate)) {
        return Result.invalid("The downloaded APK is not signed by this app.");
      }
      return Result.valid();
    } catch (PackageManager.NameNotFoundException e) {
      return Result.invalid("The installed app could not be inspected.");
    } catch (Exception e) {
      return Result.invalid("The downloaded update could not be verified.");
    }
  }

  private static int signingFlags() {
    // GET_SIGNATURES is still the reliable way to read an archive's signer on
    // Android 9; the modern flag can leave an unopened archive without one.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      return PackageManager.GET_SIGNATURES | PackageManager.GET_SIGNING_CERTIFICATES;
    }
    return PackageManager.GET_SIGNATURES;
  }

  private static long versionCode(PackageInfo info) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return info.getLongVersionCode();
    return info.versionCode;
  }

  private static boolean sameSigner(PackageInfo installed, PackageInfo candidate) {
    Signature[] a = signingCertificates(installed);
    Signature[] b = signingCertificates(candidate);
    if (a == null || b == null || a.length == 0 || b.length == 0) return false;
    return signerKeys(a).equals(signerKeys(b));
  }

  private static Signature[] signingCertificates(PackageInfo info) {
    if (info.signatures != null && info.signatures.length > 0) return info.signatures;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      if (info.signingInfo == null) return null;
      Signature[] current = info.signingInfo.getApkContentsSigners();
      if (current != null && current.length > 0) return current;
      return info.signingInfo.getSigningCertificateHistory();
    }
    return null;
  }

  private static Set<String> signerKeys(Signature[] signatures) {
    Set<String> keys = new TreeSet<>();
    if (signatures == null) return keys;
    for (Signature signature : signatures) {
      try {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        keys.add(hex(digest.digest(signature.toByteArray())));
      } catch (Exception e) {
        return new TreeSet<>();
      }
    }
    return keys;
  }

  private static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
    return result.toString();
  }
}
