package com.janeasystems.rn_nodejs_mobile;

// The Node runtime runner, de-React-Native'd from nodejs-mobile-react-native
// 18.20.4. The package name and the class name are load-bearing: the JNI
// symbols in native-lib.cpp are bound to
// com.janeasystems.rn_nodejs_mobile.RNNodeJsMobileModule and the bridge calls
// back into the static sendMessageToApplication below.
//
// What it does: on first launch (and after every APK update) the nodejs-project
// folder is copied out of the APK's assets into the app's private storage, and
// Node is started in a background thread against it. The WebView then talks to
// the servers that Node hosts on the loopback.

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.concurrent.Semaphore;

public class RNNodeJsMobileModule {

  private static final String TAG = "NODEJS-RN";
  private static final String NODEJS_PROJECT_DIR = "nodejs-project";
  private static final String NODEJS_BUILTIN_MODULES = "nodejs-builtin_modules";
  private static final String TRASH_DIR = "nodejs-project-trash";
  private static final String SHARED_PREFS = "NODEJS_MOBILE_PREFS";
  private static final String LAST_UPDATED_TIME = "NODEJS_MOBILE_APK_LastUpdateTime";
  private static final String BUILTIN_NATIVE_ASSETS_PREFIX = "nodejs-native-assets-";
  private static final String SYSTEM_CHANNEL = "_SYSTEM_";

  private static String trashDirPath;
  private static String filesDirPath;
  private static String nodeJsProjectPath;
  private static String builtinModulesPath;
  private static String nativeAssetsPath;

  private static long lastUpdateTime = 1;
  private static long previousLastUpdateTime = 0;
  private static Semaphore initSemaphore = new Semaphore(1);
  private static boolean initCompleted = false;

  private static AssetManager assetManager;

  static {
    System.loadLibrary("nodejs-mobile-react-native-native-lib");
    System.loadLibrary("node");
  }

  private static boolean _startedNodeAlready = false;

  public RNNodeJsMobileModule(Context context) {
    filesDirPath = context.getFilesDir().getAbsolutePath();

    nodeJsProjectPath = filesDirPath + "/" + NODEJS_PROJECT_DIR;
    builtinModulesPath = filesDirPath + "/" + NODEJS_BUILTIN_MODULES;
    trashDirPath = filesDirPath + "/" + TRASH_DIR;
    nativeAssetsPath = BUILTIN_NATIVE_ASSETS_PREFIX + getCurrentABIName();

    try {
      Os.setenv("TMPDIR", context.getCacheDir().getAbsolutePath(), true);
    } catch (ErrnoException e) {
      e.printStackTrace();
    }

    registerNodeDataDirPath(filesDirPath);
    asyncInit(context);
  }

  private void asyncInit(Context context) {
    if (wasAPKUpdated(context)) {
      try {
        initSemaphore.acquire();
        new Thread(new Runnable() {
          @Override
          public void run() {
            emptyTrash();
            try {
              copyNodeJsAssets(context);
              initCompleted = true;
            } catch (IOException e) {
              throw new RuntimeException("Node assets copy failed", e);
            }
            initSemaphore.release();
            emptyTrash();
          }
        }).start();
      } catch (InterruptedException ie) {
        initSemaphore.release();
        ie.printStackTrace();
      }
    } else {
      initCompleted = true;
    }
  }

  /** Start `nodejs-project/main.js` in a background thread. */
  public void startNodeProject(final String mainFileName) {
    if (_startedNodeAlready) return;
    _startedNodeAlready = true;

    new Thread(new Runnable() {
      @Override
      public void run() {
        waitForInit();
        startNodeWithArguments(new String[]{"node", nodeJsProjectPath + "/" + mainFileName},
            nodeJsProjectPath + ":" + builtinModulesPath,
            true); // stdout and stderr go to logcat
      }
    }).start();
  }

  // Messages that come back from Node through the bridge. Koma does not use
  // the bridge — its page talks HTTP to the loopback — so they are logged.
  public static void sendMessageToApplication(String channelName, String msg) {
    if (SYSTEM_CHANNEL.equals(channelName)) {
      // "ready-for-app-events" and friends: nothing to do here.
      return;
    }
    Log.d(TAG, "node -> app [" + channelName + "] " + msg);
  }

  public static void handleAppChannelMessage(String msg) { /* bridge system messages */ }

  // Called from JNI when node sends a message through the bridge.
  public static void sendMessageBackToReact(String channelName, String msg) {
    sendMessageToApplication(channelName, msg);
  }

  public native void registerNodeDataDirPath(String dataDir);

  public native String getCurrentABIName();

  public native Integer startNodeWithArguments(String[] arguments, String modulesPath, boolean option_redirectOutputToLogcat);

  public native void sendMessageToNodeChannel(String channelName, String msg);

  private void waitForInit() {
    if (!initCompleted) {
      try {
        initSemaphore.acquire();
        initSemaphore.release();
      } catch (InterruptedException ie) {
        initSemaphore.release();
        ie.printStackTrace();
      }
    }
  }

  private boolean wasAPKUpdated(Context context) {
    SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS, Context.MODE_PRIVATE);
    previousLastUpdateTime = prefs.getLong(LAST_UPDATED_TIME, 0);
    try {
      PackageInfo packageInfo = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
      lastUpdateTime = packageInfo.lastUpdateTime;
    } catch (PackageManager.NameNotFoundException e) {
      e.printStackTrace();
    }
    return lastUpdateTime != previousLastUpdateTime;
  }

  private void saveLastUpdateTime(Context context) {
    SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS, Context.MODE_PRIVATE);
    SharedPreferences.Editor editor = prefs.edit();
    editor.putLong(LAST_UPDATED_TIME, lastUpdateTime);
    editor.commit();
  }

  private void emptyTrash() {
    File trash = new File(trashDirPath);
    if (trash.exists()) deleteFolderRecursively(trash);
  }

  private static void deleteFolderRecursively(File file) {
    try {
      for (File childFile : file.listFiles()) {
        if (childFile.isDirectory()) deleteFolderRecursively(childFile);
        else childFile.delete();
      }
      file.delete();
    } catch (Exception e) {
      e.printStackTrace();
    }
  }

  private boolean copyNativeAssetsFrom() throws IOException {
    // Native addons ship per ABI; Koma's runtime is pure JavaScript, so this
    // folder is usually absent and the read below fails into empty lists.
    ArrayList<String> nativeDirs = readFileFromAssets(nativeAssetsPath + "/dir.list");
    ArrayList<String> nativeFiles = readFileFromAssets(nativeAssetsPath + "/file.list");
    if (nativeFiles.size() > 0) {
      for (String dir : nativeDirs) new File(nodeJsProjectPath + "/" + dir).mkdirs();
      for (String file : nativeFiles) copyAsset(nativeAssetsPath + "/" + file, nodeJsProjectPath + "/" + file);
    }
    return true;
  }

  private void copyNodeJsAssets(Context context) throws IOException {
    assetManager = context.getAssets();

    // A previous project folder moves to the trash and is replaced.
    File nodeDirReference = new File(nodeJsProjectPath);
    if (nodeDirReference.exists()) {
      File trash = new File(trashDirPath);
      nodeDirReference.renameTo(trash);
    }

    ArrayList<String> dirs = readFileFromAssets("dir.list");
    ArrayList<String> files = readFileFromAssets("file.list");

    if (dirs.size() > 0 && files.size() > 0) {
      Log.d(TAG, "Node assets copy using pre-built lists");
      for (String dir : dirs) new File(filesDirPath + "/" + dir).mkdirs();
      for (String file : files) copyAsset(file, filesDirPath + "/" + file);
    } else {
      Log.d(TAG, "Node assets copy enumerating APK assets");
      copyAssetFolder(NODEJS_PROJECT_DIR, nodeJsProjectPath);
    }

    copyNativeAssetsFrom();

    File modulesDirReference = new File(builtinModulesPath);
    if (modulesDirReference.exists()) deleteFolderRecursively(modulesDirReference);
    try {
      copyAssetFolder(NODEJS_BUILTIN_MODULES, builtinModulesPath);
    } catch (IOException e) {
      // The bridge module is optional for us: the page talks HTTP to the
      // loopback, not the node bridge. A missing copy must not stop Node.
      Log.w(TAG, "builtin modules copy skipped: " + e);
    }

    saveLastUpdateTime(context);
    Log.d(TAG, "Node assets copy completed successfully");
  }

  private ArrayList<String> readFileFromAssets(String filename) {
    ArrayList<String> lines = new ArrayList<>();
    try {
      BufferedReader reader = new BufferedReader(new InputStreamReader(assetManager.open(filename)));
      String line = reader.readLine();
      while (line != null) {
        lines.add(line);
        line = reader.readLine();
      }
      reader.close();
    } catch (FileNotFoundException e) {
      Log.d(TAG, "File not found: " + filename);
    } catch (IOException e) {
      lines = new ArrayList<>();
      e.printStackTrace();
    }
    return lines;
  }

  private static void copyAssetFolder(String fromAssetPath, String toPath) throws IOException {
    String[] files = assetManager.list(fromAssetPath);
    if (files.length == 0) {
      copyAsset(fromAssetPath, toPath);
    } else {
      new File(toPath).mkdirs();
      for (String file : files) copyAssetFolder(fromAssetPath + "/" + file, toPath + "/" + file);
    }
  }

  private static void copyAsset(String fromAssetPath, String toPath) throws IOException {
    InputStream in = null;
    OutputStream out = null;
    in = assetManager.open(fromAssetPath);
    new File(toPath).createNewFile();
    out = new FileOutputStream(toPath);
    copyFile(in, out);
    in.close();
    in = null;
    out.flush();
    out.close();
    out = null;
  }

  private static void copyFile(InputStream in, OutputStream out) throws IOException {
    byte[] buffer = new byte[1024];
    int read;
    while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
  }
}
