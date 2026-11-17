package com.koma.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** Opens Android's package installer for an already verified update APK. */
final class UpdateInstaller {

  static final class Result {
    final boolean needsInstallPermission;
    final String error;

    private Result(boolean needsInstallPermission, String error) {
      this.needsInstallPermission = needsInstallPermission;
      this.error = error == null ? "" : error;
    }

    static Result started() {
      return new Result(false, "");
    }

    static Result permissionNeeded() {
      return new Result(true, "Allow Koma to install updates in Android Settings, then try again.");
    }

    static Result failed(String error) {
      return new Result(false, error);
    }
  }

  private UpdateInstaller() { }

  static Result install(Activity activity, File apk, String expectedVersion) {
    if (apk == null || !apk.isFile()) {
      return Result.failed("The downloaded update is no longer available.");
    }
    ApkValidator.Result validation = ApkValidator.validate(
        activity, apk, activity.getPackageName(), expectedVersion);
    if (!validation.valid) return Result.failed(validation.message);

    File shared = new File(activity.getFilesDir(), "updates/" + ApkFileProvider.APK_PATH);
    try {
      copy(apk, shared);
    } catch (Exception e) {
      return Result.failed("The update could not be prepared for installation.");
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        && !activity.getPackageManager().canRequestPackageInstalls()) {
      try {
        Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
        settings.setData(Uri.parse("package:" + activity.getPackageName()));
        settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(settings);
        return Result.permissionNeeded();
      } catch (ActivityNotFoundException e) {
        return Result.failed("This device cannot open Android's install-permission settings.");
      }
    }

    Uri uri = ApkFileProvider.uri(activity, shared);
    Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE);
    install.setDataAndType(uri, "application/vnd.android.package-archive");
    install.setClipData(ClipData.newRawUri("Koma update", uri));
    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    try {
      activity.startActivity(install);
      return Result.started();
    } catch (ActivityNotFoundException e) {
      return Result.failed("This device does not have an Android package installer.");
    } catch (SecurityException e) {
      return Result.failed("Android refused access to the package installer.");
    }
  }

  private static void copy(File source, File destination) throws Exception {
    File parent = destination.getParentFile();
    if (parent != null) parent.mkdirs();
    File part = new File(destination.getPath() + ".part");
    try (InputStream input = new FileInputStream(source);
         OutputStream output = new FileOutputStream(part)) {
      byte[] buffer = new byte[64 * 1024];
      int count;
      while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
    }
    if (destination.exists() && !destination.delete()) {
      throw new IllegalStateException("The old installer copy could not be replaced.");
    }
    if (!part.renameTo(destination)) throw new IllegalStateException("The installer copy failed.");
  }
}
