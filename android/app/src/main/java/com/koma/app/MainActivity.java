package com.koma.app;

import android.app.Activity;
import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import com.janeasystems.rn_nodejs_mobile.RNNodeJsMobileModule;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Koma on Android: start the native Rust server for the site and its API,
 * keep the Node runtime for the separate AniVault streaming sidecar, wait for
 * the site to answer, and show it in a WebView. Everything the page does
 * afterwards is the same as in a browser — no special bridge for the core
 * features.
 */
public class MainActivity extends Activity {

  private static final int SITE_PORT_START = 4180;
  private static final Pattern ANIVAULT_KEY = Pattern.compile(
      "^ANIVAULT_API_KEY=(.+)$", Pattern.MULTILINE);

  /* The native server is kept for the life of the app process. An Activity can
     go away while the server keeps serving the loopback. */
  private static Process komaServerProcess;
  private static boolean anivaultSidecarStarted = false;
  private static WifiManager.MulticastLock roomMulticastLock;

  private WebView webView;
  private FrameLayout rootLayout;
  private View customView;
  private WebChromeClient.CustomViewCallback customViewCallback;

  /* The remote's keys go to the page, not to the WebView: the page knows
     what has the focus and what the pad should do with it. */
  private final Handler ui = new Handler(Looper.getMainLooper());
  private Runnable holdKey = null;
  private long lastPadKey = 0;         // when the pad was last passed on
  private static final long REPEAT_MS = 70;  // how fast a held pad walks

  /**
   * The app's own diagnosis trail: every stage lands in a file the user can
   * hand over, because "it just closes" with no error is not diagnosable from
   * the outside. Two copies - private storage and the app's external dir -
   * so either is reachable depending on what tools are available.
   */
  static void trace(Context c, String line) {
    String stamp = new java.text.SimpleDateFormat("MM-dd HH:mm:ss.SSS", java.util.Locale.US)
        .format(new java.util.Date());
    String entry = stamp + " " + line + "\n";
    try {
      OutputStream out = new FileOutputStream(new File(c.getFilesDir(), "koma-log.txt"), true);
      out.write(entry.getBytes());
      out.close();
    } catch (Exception ignored) { }
    try {
      File ext = c.getExternalFilesDir(null);
      if (ext != null) {
        OutputStream out = new FileOutputStream(new File(ext, "koma-log.txt"), true);
        out.write(entry.getBytes());
        out.close();
      }
    } catch (Exception ignored) { }
    Log.d("KomaApp", line);
  }

  static void traceThrowable(Context c, String what, Throwable e) {
    java.io.StringWriter sw = new java.io.StringWriter();
    e.printStackTrace(new java.io.PrintWriter(sw));
    trace(c, what + ": " + sw);
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // Anything that kills the process writes its trace first.
    final Thread.UncaughtExceptionHandler prior = Thread.getDefaultUncaughtExceptionHandler();
    Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
      traceThrowable(this, "uncaught exception on " + t.getName(), e);
      if (prior != null) prior.uncaughtException(t, e);
    });
    trace(this, "app opening, build 1.7.16.3");

    // Edge to edge: the app draws under the system bars, so there are no
    // black bands at the notch or above the gesture pill - the page's own
    // background and safe-area padding own those regions.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      getWindow().setDecorFitsSystemWindows(false);
    } else {
      getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }
    getWindow().setStatusBarColor(Color.TRANSPARENT);
    getWindow().setNavigationBarColor(Color.TRANSPARENT);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      WindowManager.LayoutParams lp = getWindow().getAttributes();
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      getWindow().setAttributes(lp);
    }

    // A television has no status bar and no navigation bar: the picture is
    // the page, and every row the bars take is a row the video does not get.
    // The bars come back by a swipe, the way they do on a set-top box.
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    // The device's media volume governs the app: the volume keys change the
    // stream the WebView plays through, so nothing ever plays at a level the
    // user did not set.
    setVolumeControlStream(AudioManager.STREAM_MUSIC);

    rootLayout = new FrameLayout(this);
    rootLayout.setBackgroundColor(Color.BLACK);
    webView = new WebView(this);
    rootLayout.addView(webView, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(rootLayout);

    // A television has no status bar and no navigation bar: the picture is
    // the page, and every row the bars take is a row the video does not get.
    // The bars come back by a swipe, the way they do on a set-top box.
    if (BuildConfig.IS_TV) applyImmersive(true);

    WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect while testing
    WebSettings s = webView.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);            // the library, progress, preferences
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setUseWideViewPort(true);
    // Overview mode shrinks the page to fit content that is wider than the
    // screen and then lets it be panned around. The layout is the app's own
    // and always fits, so the page stays at the device's width.
    s.setLoadWithOverviewMode(false);
    // Pinch and double-tap zoom are desktop-browser leftovers here: the layout
    // is the app's own, and an accidental pinch left the user panning a
    // half-zoomed page around.
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    webView.setWebChromeClient(new VideoChromeClient());
    // The page reads the app's version through this - the footer then says
    // "Koma 1.7.16 - Up to date" instead of presenting the app as a web page.
    webView.addJavascriptInterface(new KomaBridge(), "KomaAndroid");
    trace(this, "webview ready");

    acquireRoomMulticastLock();
    startServers();
  }

  /**
   * Copy the site, start the AniVault sidecar, then start the native Koma
   * server. The copy and both startups stay off the UI thread.
   */
  private void startServers() {
    new Thread(new Runnable() {
      @Override
      public void run() {
        try {
          if (processRunning(komaServerProcess)) {
            trace(MainActivity.this, "the native koma server is already running");
            waitForSite();
            return;
          }

          trace(MainActivity.this, "preparing the native koma server files");
          prepareKomaAssets();

          startAniVaultSidecar();
          int anivaultPort = waitForAnivaultPort();
          int sitePort = chooseSitePort(anivaultPort);
          trace(MainActivity.this, "starting native koma server on " + sitePort
              + " with anivault on " + anivaultPort);

          startKomaServer(sitePort, anivaultPort);
          writeSitePort(sitePort);
          trace(MainActivity.this, "native koma server started, waiting for the site");
          waitForSite();
        } catch (Throwable t) {
          traceThrowable(MainActivity.this, "the native koma server could not start", t);
        }
      }
    }).start();
  }

  /**
   * The packaged site is copied out of the APK once per APK update. The two
   * directories are the public site and the writable data the Rust server
   * uses for its language catalogues.
   */
  private void prepareKomaAssets() throws IOException {
    File siteRoot = new File(getFilesDir(), "koma-site");
    File publicDir = new File(siteRoot, "public");
    File dataDir = new File(siteRoot, "server/data");
    File marker = new File(siteRoot, ".assets-stamp");
    String stamp = assetStamp();
    String copiedStamp = readText(marker);

    if (!publicDir.isDirectory() || !dataDir.isDirectory()
        || copiedStamp == null || !copiedStamp.trim().equals(stamp)) {
      deleteTree(publicDir);
      deleteTree(dataDir);
      copyAssetTree("koma-site/public", publicDir);
      copyAssetTree("koma-site/server/data", dataDir);
      writeText(marker, stamp);
      trace(this, "native koma server assets copied");
    }
  }

  /** Node remains only for the separate AniVault streaming API. */
  private void startAniVaultSidecar() {
    if (anivaultSidecarStarted) return;
    try { new File(getFilesDir(), "koma-anivault.port").delete(); } catch (Exception ignored) { }
    new RNNodeJsMobileModule(getApplicationContext()).startNodeProject("main.js");
    anivaultSidecarStarted = true;
    trace(this, "anivault node sidecar start requested");
  }

  /** Wait until the Node sidecar has chosen and reported its loopback port. */
  private int waitForAnivaultPort() throws IOException {
    for (int i = 0; i < 240; i++) { // a minute: the first asset copy takes a moment
      int port = portFile("koma-anivault.port");
      if (port > 0) return port;
      try { Thread.sleep(250); } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new IOException("interrupted while waiting for the anivault sidecar", e);
      }
    }
    throw new IOException("the anivault sidecar did not report a port");
  }

  /** Pick the first free loopback port at or above 4180. */
  private int chooseSitePort(int anivaultPort) throws IOException {
    for (int port = SITE_PORT_START; port < SITE_PORT_START + 100; port++) {
      if (port == anivaultPort) continue;
      if (isPortFree(port)) return port;
    }
    throw new IOException("no free koma site port at or above " + SITE_PORT_START);
  }

  private boolean isPortFree(int port) {
    try (ServerSocket probe = new ServerSocket()) {
      probe.setReuseAddress(false);
      probe.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
      return true;
    } catch (IOException e) {
      return false;
    }
  }

  /**
   * Start the packaged native server. Its output is drained on a daemon thread
   * so a chatty server cannot fill a pipe and stop answering requests.
   */
  private void startKomaServer(int sitePort, int anivaultPort) throws IOException {
    File server = new File(getApplicationInfo().nativeLibraryDir, "libkoma_server.so");
    if (!server.isFile()) {
      throw new IOException("native koma server is missing: " + server.getAbsolutePath());
    }
    if (!server.canExecute() && !server.setExecutable(true, false)) {
      throw new IOException("native koma server is not executable: " + server.getAbsolutePath());
    }

    ProcessBuilder builder = new ProcessBuilder(server.getAbsolutePath());
    builder.redirectErrorStream(true);
    builder.environment().put("KOMA_PUBLIC_DIR",
        new File(getFilesDir(), "koma-site/public").getAbsolutePath());
    builder.environment().put("KOMA_DATA_DIR",
        new File(getFilesDir(), "koma-site/server/data").getAbsolutePath());
    builder.environment().put("KOMA_ANIVAULT_KEY", anivaultKey());
    builder.environment().put("KOMA_ANIVAULT_URL", "http://127.0.0.1:" + anivaultPort);
    builder.environment().put("KOMA_VERSION", BuildConfig.VERSION_NAME);
    String lanAddress = activeLanAddress();
    if (!lanAddress.isEmpty()) {
      builder.environment().put("KOMA_LAN_ADDRESS", lanAddress);
    }
    builder.environment().put("PORT", String.valueOf(sitePort));
    builder.environment().put("HOST", "127.0.0.1");

    Process process = builder.start();
    komaServerProcess = process;
    logKomaServerOutput(getApplicationContext(), process);
  }

  /**
   * The address of the network other devices can reach this one on. Android's
   * NDK does not expose getifaddrs at the supported API level, so the app
   * finds the active network and hands its IPv4 address to the Rust server.
   */
  private String activeLanAddress() {
    try {
      ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
      if (manager != null) {
        Network network = manager.getActiveNetwork();
        LinkProperties properties = manager.getLinkProperties(network);
        if (properties != null) {
          for (LinkAddress link : properties.getLinkAddresses()) {
            InetAddress address = link.getAddress();
            if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
              return address.getHostAddress();
            }
          }
        }
      }
    } catch (Exception ignored) { }

    try {
      java.util.Enumeration<java.net.NetworkInterface> interfaces = java.net.NetworkInterface.getNetworkInterfaces();
      while (interfaces != null && interfaces.hasMoreElements()) {
        java.net.NetworkInterface network = interfaces.nextElement();
        String name = network.getName().toLowerCase(java.util.Locale.US);
        if (network.isLoopback() || !network.isUp()
            || name.matches(".*(rmnet|ccmni|tun|ppp).*")) continue;
        java.util.Enumeration<InetAddress> addresses = network.getInetAddresses();
        while (addresses.hasMoreElements()) {
          InetAddress address = addresses.nextElement();
          if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
            return address.getHostAddress();
          }
        }
      }
    } catch (Exception ignored) { }
    return "";
  }

  /** Android filters multicast packets from Wi-Fi unless the app holds this lock. */
  private void acquireRoomMulticastLock() {
    try {
      WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
      if (wifi == null) return;
      roomMulticastLock = wifi.createMulticastLock("koma-room");
      roomMulticastLock.setReferenceCounted(false);
      roomMulticastLock.acquire();
    } catch (Exception ignored) { }
  }

  private static void logKomaServerOutput(final Context context, final Process process) {
    Thread reader = new Thread(new Runnable() {
      @Override
      public void run() {
        try (BufferedReader r = new BufferedReader(
            new InputStreamReader(process.getInputStream()))) {
          String line;
          while ((line = r.readLine()) != null) {
            trace(context, "koma-server: " + line);
          }
        } catch (Exception e) {
          if (processRunning(process)) {
            traceThrowable(context, "koma-server output stopped", e);
          }
        }
      }
    });
    reader.setDaemon(true);
    reader.start();
  }

  /** Poll the site until the native server answers, then load it. */
  private boolean waitForSite() {
    for (int i = 0; i < 120; i++) { // a minute: the first asset copy takes a moment
      int port = sitePort();
      if (port > 0 && pingSite(port)) {
        final int p = port;
        runOnUiThread(new Runnable() {
          @Override
          public void run() {
            if (webView == null) return;
            trace(MainActivity.this, "loading the site in the webview");
            // The television app opens the site in television mode, so the
            // layout and the remote's navigation are the television's.
            webView.loadUrl("http://127.0.0.1:" + p + (BuildConfig.IS_TV ? "/?tv=1" : "/"));
          }
        });
        return true;
      }
      if (komaServerProcess != null && !processRunning(komaServerProcess)) {
        trace(this, "the native koma server exited with code " + processExit(komaServerProcess));
        return false;
      }
      try { Thread.sleep(500); } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return false;
      }
    }
    trace(this, "the site never answered after a minute");
    return false;
  }

  /**
   * The port the native site server took. The phone app and the television app
   * can be installed side by side, so the app picks the first free port at or
   * above 4180 and writes it down here.
   */
  private int sitePort() {
    return portFile("koma-site.port");
  }

  private int portFile(String name) {
    File f = new File(getFilesDir(), name);
    if (!f.exists()) return 0;
    try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f)))) {
      String line = r.readLine();
      int p = Integer.parseInt(line.trim());
      return p > 0 ? p : 0;
    } catch (Exception e) {
      return 0;
    }
  }

  private void writeSitePort(int port) throws IOException {
    writeText(new File(getFilesDir(), "koma-site.port"), port + "\n");
  }

  private String assetStamp() {
    try {
      android.content.pm.PackageInfo info = getPackageManager()
          .getPackageInfo(getPackageName(), 0);
      return info.lastUpdateTime + "-" + info.versionName;
    } catch (Exception e) {
      return BuildConfig.VERSION_NAME;
    }
  }

  private void copyAssetTree(String assetPath, File target) throws IOException {
    AssetManager assets = getAssets();
    String[] children = assets.list(assetPath);
    if (children == null || children.length == 0) {
      copyAssetFile(assetPath, target);
      return;
    }
    if (!target.isDirectory() && !target.mkdirs()) {
      throw new IOException("could not create " + target.getAbsolutePath());
    }
    for (String child : children) {
      copyAssetTree(assetPath + "/" + child, new File(target, child));
    }
  }

  private void copyAssetFile(String assetPath, File target) throws IOException {
    File parent = target.getParentFile();
    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
      throw new IOException("could not create " + parent.getAbsolutePath());
    }
    try (InputStream in = getAssets().open(assetPath);
         FileOutputStream out = new FileOutputStream(target)) {
      byte[] buffer = new byte[16384];
      int n;
      while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
    }
  }

  private String readAssetText(String assetPath) throws IOException {
    try (BufferedReader r = new BufferedReader(
        new InputStreamReader(getAssets().open(assetPath)))) {
      StringBuilder text = new StringBuilder();
      String line;
      while ((line = r.readLine()) != null) text.append(line).append('\n');
      return text.toString();
    }
  }

  private String anivaultKey() throws IOException {
    String env = readAssetText("nodejs-project/anivault.env");
    Matcher matcher = ANIVAULT_KEY.matcher(env);
    if (!matcher.find()) throw new IOException("no ANIVAULT_API_KEY in the packaged assets");
    return matcher.group(1).trim();
  }

  private String readText(File file) {
    if (!file.exists()) return null;
    try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(file)))) {
      StringBuilder text = new StringBuilder();
      String line;
      while ((line = r.readLine()) != null) text.append(line).append('\n');
      return text.toString();
    } catch (Exception e) {
      return null;
    }
  }

  private void writeText(File file, String text) throws IOException {
    File parent = file.getParentFile();
    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
      throw new IOException("could not create " + parent.getAbsolutePath());
    }
    try (FileOutputStream out = new FileOutputStream(file)) {
      out.write(text.getBytes(StandardCharsets.UTF_8));
    }
  }

  private static boolean processRunning(Process process) {
    if (process == null) return false;
    try {
      process.exitValue();
      return false;
    } catch (IllegalThreadStateException e) {
      return true;
    }
  }

  private static int processExit(Process process) {
    try {
      return process.exitValue();
    } catch (IllegalThreadStateException e) {
      return -1;
    }
  }

  private static void deleteTree(File file) {
    if (file == null || !file.exists()) return;
    if (file.isDirectory()) {
      File[] children = file.listFiles();
      if (children != null) {
        for (File child : children) deleteTree(child);
      }
    }
    file.delete();
  }

  private boolean pingSite(int port) {
    try {
      HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/koma").openConnection();
      c.setConnectTimeout(1500);
      c.setReadTimeout(1500);
      try {
        BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()));
        String body = r.readLine();
        r.close();
        boolean ok = body != null && body.contains("\"koma\"");
        if (ok) trace(this, "site answered on " + port + ": " + body);
        return ok;
      } finally {
        c.disconnect();
      }
    } catch (Exception e) {
      return false;
    }
  }

  /** The version, read by the page: the footer reports the app, not "web". */
  private class KomaBridge {
    @JavascriptInterface
    public String version() {
      try {
        return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
      } catch (Exception e) {
        return "";
      }
    }

    /** Is this the television build? The page asks before it draws. */
    @JavascriptInterface
    public boolean isTv() {
      return BuildConfig.IS_TV;
    }

    /**
     * Give the video the whole screen: the system bars go away and the page
     * gets every pixel of the display.
     */
    @JavascriptInterface
    public void immersive(final boolean on) {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          applyImmersive(on);
        }
      });
    }

    /**
     * Leave the app. The remote's back button asks for this when the page
     * has nowhere left to go back to.
     */
    @JavascriptInterface
    public void exit() {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          finish();
        }
      });
    }

    /**
     * Show or put away the soft keyboard.
     *
     * A television has no keyboard of its own, so the search screen asks the
     * system for one when the field takes the focus, and puts it away when
     * the search is over.
     */
    @JavascriptInterface
    public void setTextEntry(final boolean on) {
      runOnUiThread(new Runnable() {
        @Override
        public void run() {
          try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm == null) return;
            if (on) {
              // The field in the page has the focus; the WebView is the view
              // that holds it, so the keyboard is asked for on the WebView.
              webView.requestFocus();
              imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT);
            } else {
              imm.hideSoftInputFromWindow(webView.getWindowToken(), 0);
            }
          } catch (Exception e) {
            Log.w("Koma", "text entry: " + e);
          }
        }
      });
    }
  }

  /** Hide or show the system bars around the app. */
  private void applyImmersive(boolean on) {
    // A television has no bars of its own: they stay out of the way for
    // good, whether the picture is full screen or not.
    if (BuildConfig.IS_TV && !on) return;
    View decor = getWindow().getDecorView();
    if (on) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) {
          c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
          c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
      } else {
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
      }
    } else {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
      } else {
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
      }
    }
  }

  /* ---------- the remote ---------- */

  /** The name the page knows a key by, or null if the key is not ours. */
  private String remoteKey(int keyCode, KeyEvent event) {
    switch (keyCode) {
      case KeyEvent.KEYCODE_DPAD_UP: return "up";
      case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
      case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
      case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
      case KeyEvent.KEYCODE_DPAD_CENTER:
      case KeyEvent.KEYCODE_ENTER:
      case KeyEvent.KEYCODE_NUMPAD_ENTER:
      // The A button of a controller is the same thing as the middle button
      // of a remote.
      case KeyEvent.KEYCODE_BUTTON_A: return "center";
      case KeyEvent.KEYCODE_BACK: return "back";
      case KeyEvent.KEYCODE_MENU: return "menu";
      case KeyEvent.KEYCODE_HELP: return "menu";
      case KeyEvent.KEYCODE_MEDIA_PLAY: return "play";
      case KeyEvent.KEYCODE_MEDIA_PAUSE: return "pause";
      case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return "playpause";
      case KeyEvent.KEYCODE_MEDIA_NEXT: return "next";
      default: return null;
    }
  }

  private boolean isPad(int keyCode) {
    return keyCode == KeyEvent.KEYCODE_DPAD_UP || keyCode == KeyEvent.KEYCODE_DPAD_DOWN
        || keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT;
  }

  /** Hand a key to the page. */
  private void sendKey(String name) {
    final String js = "window.__komaTv && window.__komaTv.key(" + JSONObject.quote(name) + ")";
    runOnUiThread(new Runnable() {
      @Override
      public void run() {
        if (webView != null) webView.evaluateJavascript(js, null);
      }
    });
  }

  /**
   * The remote belongs to the page.
   *
   * The key is taken here, before the WebView ever sees it. A WebView that
   * gets the pad itself moves its own focus (and wraps round to the top of
   * the page), scrolls a little at a time, opens drop-downs and presses
   * buttons - none of which is what a television is for. The page knows what
   * has the focus and what the pad should do with it, so the page is told.
   */
  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    if (!BuildConfig.IS_TV) return super.dispatchKeyEvent(event);
    int code = event.getKeyCode();
    String name = remoteKey(code, event);
    if (name == null) return super.dispatchKeyEvent(event);

    int action = event.getAction();
    if (action == KeyEvent.ACTION_DOWN) {
      // A held-down pad walks along the row: the repeats of the key are
      // the viewer saying "keep going". They come thick and fast, so they
      // are spaced out a little before the page is told.
      if (isPad(code)) {
        long now = android.os.SystemClock.uptimeMillis();
        if (event.getRepeatCount() == 0) {
          sendKey(name);
          lastPadKey = now;
        } else if (now - lastPadKey >= REPEAT_MS) {
          sendKey(name);
          lastPadKey = now;
        }
        return true;
      }
      // A held-down centre button opens the card's menu; a short press opens
      // the card. The page tells the two apart by the order they arrive in.
      if ("center".equals(name)) {
        if (event.getRepeatCount() == 0) {
          holdKey = new Runnable() {
            @Override
            public void run() {
              holdKey = null;
              sendKey("hold");
            }
          };
          ui.postDelayed(holdKey, 600);
        }
        return true;
      }
      if (event.getRepeatCount() == 0) sendKey(name);
      return true;
    }
    if (action == KeyEvent.ACTION_UP) {
      if ("center".equals(name)) {
        if (holdKey != null) {
          ui.removeCallbacks(holdKey);
          holdKey = null;
        }
        // The release is always sent. After a long press the page has already
        // opened the card menu; it uses this release to ignore that one
        // activation without swallowing the viewer's next press.
        sendKey("center");
      }
      return true;
    }
    return true;
  }

  /** Fullscreen video: the player's own button hands the view over here. */
  private class VideoChromeClient extends WebChromeClient {    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
      if (customView != null) { callback.onCustomViewHidden(); return; }
      customView = view;
      customViewCallback = callback;
      webView.setVisibility(View.GONE);
      rootLayout.addView(view, new FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    @Override
    public void onHideCustomView() {
      if (customView == null) return;
      rootLayout.removeView(customView);
      customView = null;
      webView.setVisibility(View.VISIBLE);
      if (customViewCallback != null) {
        customViewCallback.onCustomViewHidden();
        customViewCallback = null;
      }
    }
  }

  @Override
  public void onBackPressed() {
    // Fullscreen video first, then the page's own panels: the page is asked
    // whether it wants the back button - an open drawer or panel takes it -
    // and only then does the app go back.
    if (customView != null) {
      ((VideoChromeClient) webView.getWebChromeClient()).onHideCustomView();
      return;
    }
    webView.evaluateJavascript(
        "(function(){try{return !!(window.__komaBack && window.__komaBack());}catch(e){return false;}})()",
        value -> {
          if ("true".equals(value)) return;
          if (webView.canGoBack()) webView.goBack();
          else MainActivity.super.onBackPressed();
        });
  }

  @Override
  protected void onPause() {
    super.onPause();
    webView.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    webView.onResume();
  }

  @Override
  protected void onDestroy() {
    // The native server keeps running with the app process; the WebView goes.
    if (roomMulticastLock != null && roomMulticastLock.isHeld()) {
      try { roomMulticastLock.release(); } catch (Exception ignored) { }
      roomMulticastLock = null;
    }
    if (webView != null) {
      webView.loadUrl("about:blank");
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }
}
