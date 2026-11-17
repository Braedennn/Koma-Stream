package com.koma.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/** Gives Android's package installer read access to one verified APK. */
public final class ApkFileProvider extends ContentProvider {

  static final String APK_PATH = "update.apk";

  static Uri uri(Context context, File apk) {
    return new Uri.Builder()
        .scheme("content")
        .authority(BuildConfig.APPLICATION_ID + ".updates")
        .appendPath(APK_PATH)
        .build();
  }

  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    Context providerContext = getContext();
    if (providerContext == null || !"r".equals(mode) || !APK_PATH.equals(uri.getLastPathSegment())) {
      throw new FileNotFoundException("The update file is not available.");
    }
    File updates = new File(providerContext.getFilesDir(), "updates");
    File apk = new File(updates, APK_PATH);
    try {
      String root = updates.getCanonicalPath() + File.separator;
      String path = apk.getCanonicalPath();
      if (!path.startsWith(root) || !apk.isFile()) {
        throw new FileNotFoundException("The update file is not available.");
      }
    } catch (IOException e) {
      throw new FileNotFoundException("The update file is not available.");
    }
    return ParcelFileDescriptor.open(apk, ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public String getType(Uri uri) {
    return "application/vnd.android.package-archive";
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection,
                      String[] selectionArgs, String sortOrder) {
    Context providerContext = getContext();
    if (providerContext == null) return null;
    File apk = new File(providerContext.getFilesDir(), "updates/" + APK_PATH);
    String[] columns = projection == null
        ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }
        : projection;
    MatrixCursor cursor = new MatrixCursor(columns, 1);
    Object[] values = new Object[columns.length];
    for (int i = 0; i < columns.length; i++) {
      if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) values[i] = "Koma-update.apk";
      else if (OpenableColumns.SIZE.equals(columns[i])) values[i] = apk.length();
      else values[i] = null;
    }
    cursor.addRow(values);
    return cursor;
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    throw new UnsupportedOperationException("Updates are read-only.");
  }

  @Override
  public int delete(Uri uri, String selection, String[] selectionArgs) {
    throw new UnsupportedOperationException("Updates are read-only.");
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
    throw new UnsupportedOperationException("Updates are read-only.");
  }
}
