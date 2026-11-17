package com.koma.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Numeric application versions, independent of the release tag's optional suffix. */
final class UpdateVersion {

  private static final Pattern VERSION = Pattern.compile(
      "^[vV]?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:\\.(\\d+))?(?:[-+][A-Za-z0-9.-]+)?$");

  private UpdateVersion() { }

  static int[] parse(String value) {
    if (value == null) return null;
    Matcher match = VERSION.matcher(value.trim());
    if (!match.matches()) return null;
    int[] parts = new int[] {
        Integer.parseInt(match.group(1)),
        match.group(2) == null ? 0 : Integer.parseInt(match.group(2)),
        match.group(3) == null ? 0 : Integer.parseInt(match.group(3)),
        match.group(4) == null ? 0 : Integer.parseInt(match.group(4))
    };
    return parts;
  }

  static int compare(String left, String right) {
    int[] a = parse(left);
    int[] b = parse(right);
    if (a == null || b == null) return Integer.MIN_VALUE;
    for (int i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return Integer.compare(a[i], b[i]);
    }
    return 0;
  }

  static boolean isNewer(String candidate, String installed) {
    int comparison = compare(candidate, installed);
    return comparison > 0;
  }

  static String canonical(String value) {
    int[] parts = parse(value);
    if (parts == null) return "";
    int count = parts.length;
    while (count > 1 && parts[count - 1] == 0) count--;
    StringBuilder result = new StringBuilder();
    for (int i = 0; i < count; i++) {
      if (i > 0) result.append('.');
      result.append(parts[i]);
    }
    return result.toString();
  }
}
