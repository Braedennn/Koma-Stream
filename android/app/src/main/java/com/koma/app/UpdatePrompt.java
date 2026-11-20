package com.koma.app;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.util.Locale;

/** The native update confirmation: compact on a phone, large on a television. */
final class UpdatePrompt {

  interface Callbacks {
    void onUpdateNow(File apk, String version);
    void onLater();
    void onRetry();
  }

  private final Activity activity;
  private final Callbacks callbacks;
  private final boolean tv;

  private Dialog dialog;
  private TextView versionView;
  private TextView statusView;
  private TextView notesView;
  private ProgressBar progress;
  private Button updateButton;
  private Button laterButton;
  private UpdateManager.State state;
  private boolean dismissedByAction;

  UpdatePrompt(Activity activity, Callbacks callbacks) {
    this.activity = activity;
    this.callbacks = callbacks;
    this.tv = BuildConfig.IS_TV;
  }

  boolean isShowing() {
    return dialog != null && dialog.isShowing();
  }

  void show(UpdateManager.State next) {
    state = next;
    dismissedByAction = false;
    if (dialog == null) create();
    update();
    if (!dialog.isShowing()) {
      dialog.show();
      applyWindowSize();
    }
    requestFocus();
  }

  void dismissAsLater() {
    dismissedByAction = true;
    if (dialog != null) dialog.dismiss();
  }

  /** Closes the prompt because there is nothing left to offer. */
  void dismiss() {
    dismissedByAction = true;
    if (dialog != null) dialog.dismiss();
  }

  void dismissAfterInstall() {
    dismissedByAction = true;
    if (dialog != null) dialog.dismiss();
  }

  void setPermissionMessage(String message) {
    if (statusView != null) statusView.setText(message);
  }

  void setInstallError(String message) {
    if (statusView != null) statusView.setText(message);
    if (updateButton != null) {
      updateButton.setText(tv ? "Try again" : "Try again");
      updateButton.setEnabled(true);
    }
  }

  private void create() {
    dialog = new Dialog(activity);
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
    dialog.setCancelable(true);
    dialog.setCanceledOnTouchOutside(false);

    LinearLayout content = new LinearLayout(activity);
    content.setOrientation(LinearLayout.VERTICAL);
    int padding = dp(tv ? 38 : 24);
    content.setPadding(padding, padding, padding, padding);
    content.setGravity(Gravity.CENTER_HORIZONTAL);

    TextView title = new TextView(activity);
    title.setText(tv ? "Koma update available" : "Update available");
    title.setTextColor(Color.WHITE);
    title.setTextSize(tv ? 27 : 21);
    title.setGravity(Gravity.CENTER);
    title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
    content.addView(title, matchWrap());

    versionView = new TextView(activity);
    versionView.setTextColor(Color.parseColor("#FDB770"));
    versionView.setTextSize(tv ? 19 : 14);
    versionView.setGravity(Gravity.CENTER);
    versionView.setPadding(0, dp(tv ? 12 : 7), 0, dp(tv ? 18 : 12));
    content.addView(versionView, matchWrap());

    statusView = new TextView(activity);
    statusView.setTextColor(Color.parseColor("#E7E7E7"));
    statusView.setTextSize(tv ? 18 : 14);
    statusView.setGravity(Gravity.CENTER);
    statusView.setLineSpacing(0, 1.12f);
    content.addView(statusView, matchWrap());

    progress = new ProgressBar(activity, null,
        android.R.attr.progressBarStyleHorizontal);
    progress.setMax(100);
    progress.setProgressTintList(ColorStateList.valueOf(Color.parseColor("#FDB770")));
    progress.setProgressBackgroundTintList(ColorStateList.valueOf(Color.parseColor("#3A3A3A")));
    LinearLayout.LayoutParams progressParams = matchWrap();
    progressParams.topMargin = dp(tv ? 20 : 14);
    progressParams.bottomMargin = dp(tv ? 16 : 11);
    content.addView(progress, progressParams);

    notesView = new TextView(activity);
    notesView.setTextColor(Color.parseColor("#BDBDBD"));
    notesView.setTextSize(tv ? 16 : 12.5f);
    notesView.setGravity(Gravity.CENTER);
    notesView.setMaxLines(tv ? 7 : 5);
    notesView.setEllipsize(android.text.TextUtils.TruncateAt.END);
    content.addView(notesView, matchWrap());

    LinearLayout buttons = new LinearLayout(activity);
    buttons.setOrientation(tv ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
    buttons.setGravity(Gravity.CENTER);
    int gap = dp(tv ? 18 : 10);
    buttons.setPadding(0, dp(tv ? 28 : 20), 0, 0);

    updateButton = makeButton(tv ? "Update now" : "Update now", true);
    laterButton = makeButton("Later", false);
    updateButton.setOnClickListener(view -> {
      if (state == null) return;
      if (state.kind == UpdateManager.Kind.READY) {
        callbacks.onUpdateNow(state.apk, state.version);
      } else if (state.kind == UpdateManager.Kind.FAILED
          || state.kind == UpdateManager.Kind.CHECK_FAILED) {
        callbacks.onRetry();
      }
    });
    laterButton.setOnClickListener(view -> {
      dismissedByAction = true;
      callbacks.onLater();
      dialog.dismiss();
    });

    LinearLayout.LayoutParams updateParams = new LinearLayout.LayoutParams(
        tv ? 0 : ViewGroup.LayoutParams.MATCH_PARENT,
        dp(tv ? 56 : 46),
        tv ? 1 : 0);
    LinearLayout.LayoutParams laterParams = new LinearLayout.LayoutParams(
        tv ? 0 : ViewGroup.LayoutParams.MATCH_PARENT,
        dp(tv ? 56 : 46),
        tv ? 1 : 0);
    if (tv) {
      updateParams.rightMargin = gap / 2;
      laterParams.leftMargin = gap / 2;
    } else {
      updateParams.bottomMargin = gap;
    }
    buttons.addView(updateButton, updateParams);
    buttons.addView(laterButton, laterParams);
    content.addView(buttons, matchWrap());

    GradientDrawable background = new GradientDrawable();
    background.setColor(Color.parseColor("#171717"));
    background.setCornerRadius(dp(tv ? 18 : 14));
    background.setStroke(dp(1), Color.parseColor("#383838"));
    content.setBackground(background);

    ScrollView scroll = new ScrollView(activity);
    scroll.setFillViewport(true);
    scroll.addView(content, new ScrollView.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    dialog.setContentView(scroll);

    dialog.setOnCancelListener(ignored -> {
      if (!dismissedByAction) callbacks.onLater();
    });
  }

  private void update() {
    if (state == null || versionView == null) return;
    versionView.setText(state.version.isEmpty() ? "A new Koma release" : "Version " + state.version);

    String status;
    if (state.kind == UpdateManager.Kind.DOWNLOADING) {
      if (state.total > 0) {
        double percent = Math.min(100, state.downloaded * 100.0 / state.total);
        progress.setIndeterminate(false);
        progress.setProgress((int) percent);
        status = String.format(Locale.US, "Downloading… %.1f MB of %.1f MB",
            state.downloaded / 1048576.0, state.total / 1048576.0);
      } else {
        progress.setIndeterminate(true);
        status = "Downloading the update…";
      }
    } else if (state.kind == UpdateManager.Kind.READY) {
      progress.setIndeterminate(false);
      progress.setProgress(100);
      status = "Downloaded and verified. Android will ask you to confirm the installation.";
    } else if (state.kind == UpdateManager.Kind.FAILED) {
      progress.setIndeterminate(false);
      progress.setProgress(0);
      status = state.error.isEmpty() ? "The update could not be downloaded." : state.error;
    } else if (state.kind == UpdateManager.Kind.CHECK_FAILED) {
      progress.setIndeterminate(false);
      progress.setProgress(0);
      status = state.error.isEmpty() ? "The update could not be checked." : state.error;
    } else {
      progress.setIndeterminate(false);
      progress.setProgress(0);
      status = "Checking for an update…";
    }
    statusView.setText(status);

    String notes = state.notes == null ? "" : state.notes.trim();
    if (notes.length() > 1400) notes = notes.substring(0, 1400) + "…";
    notesView.setText(notes);
    notesView.setVisibility(notes.isEmpty() ? View.GONE : View.VISIBLE);

    if (state.kind == UpdateManager.Kind.READY) {
      updateButton.setText("Update now");
      updateButton.setEnabled(true);
    } else if (state.kind == UpdateManager.Kind.FAILED
        || state.kind == UpdateManager.Kind.CHECK_FAILED) {
      updateButton.setText("Try again");
      updateButton.setEnabled(true);
    } else {
      updateButton.setText("Update now");
      updateButton.setEnabled(false);
    }
  }

  private Button makeButton(String label, boolean primary) {
    Button button = new Button(activity);
    button.setText(label);
    button.setTextSize(tv ? 18 : 15);
    button.setTextColor(primary ? Color.parseColor("#171717") : Color.WHITE);
    button.setAllCaps(false);
    button.setFocusable(true);
    button.setFocusableInTouchMode(tv);
    button.setBackgroundTintList(ColorStateList.valueOf(
        primary ? Color.parseColor("#FDB770") : Color.parseColor("#343434")));
    return button;
  }

  private void applyWindowSize() {
    Window window = dialog.getWindow();
    if (window == null) return;
    window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
    WindowManager.LayoutParams params = window.getAttributes();
    params.width = (int) (activity.getResources().getDisplayMetrics().widthPixels * (tv ? 0.72 : 0.92));
    params.height = WindowManager.LayoutParams.WRAP_CONTENT;
    params.gravity = Gravity.CENTER;
    params.dimAmount = 0.72f;
    window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
    window.setAttributes(params);
  }

  private void requestFocus() {
    if (!tv || updateButton == null || dialog == null) return;
    View target = state != null && (state.kind == UpdateManager.Kind.READY
        || state.kind == UpdateManager.Kind.FAILED
        || state.kind == UpdateManager.Kind.CHECK_FAILED)
        ? updateButton : laterButton;
    target.post(() -> {
      Window window = dialog.getWindow();
      if (window != null) {
        window.getDecorView().setFocusableInTouchMode(true);
        window.getDecorView().requestFocus();
      }
      target.requestFocus();
    });
    // The dialog window receives focus just after it is shown; ask again once
    // that has happened so the remote starts on a visible button.
    target.postDelayed(target::requestFocus, 150);
  }

  private LinearLayout.LayoutParams matchWrap() {
    return new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
  }

  private int dp(int value) {
    return Math.round(value * activity.getResources().getDisplayMetrics().density);
  }
}
