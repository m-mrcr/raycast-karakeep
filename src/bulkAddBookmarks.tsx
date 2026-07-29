import { Clipboard, showHUD, showToast, Toast } from "@raycast/api";
import fetch from "node-fetch";
import { URL } from "url";
import { getApiConfig } from "./utils/config";
import { validUrl } from "./utils/url";

// Pull http(s) URLs out of arbitrary clipboard text, strip the punctuation that
// belongs to the surrounding prose rather than the link, then dedupe.
const URL_PATTERN = /https?:\/\/[^\s"<>]+/g;
const SENTENCE_PUNCTUATION = ".,;:!?";

// A trailing ")" is only prose if it has no matching "(" inside the URL. Wikipedia
// disambiguation links such as /wiki/Function_(mathematics) keep theirs, while a
// link wrapped in prose parens or a markdown target loses the stray one.
function trimTrailingPunctuation(url: string): string {
  let trimmed = url;

  for (;;) {
    const last = trimmed.at(-1);
    if (last === undefined) break;

    if (SENTENCE_PUNCTUATION.includes(last)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }

    if (last === ")") {
      const opened = (trimmed.match(/\(/g) ?? []).length;
      const closed = (trimmed.match(/\)/g) ?? []).length;
      if (closed > opened) {
        trimmed = trimmed.slice(0, -1);
        continue;
      }
    }

    break;
  }

  return trimmed;
}

function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  const cleaned = matches.map(trimTrailingPunctuation).filter(validUrl);
  return Array.from(new Set(cleaned));
}

// A 4xx only counts as "already bookmarked" when the response actually says so.
// Karakeep's exact duplicate payload has not been confirmed against a live
// instance, so anything unrecognised is reported as a failure rather than
// quietly inflating the duplicate count.
const DUPLICATE_HINT = /already[ _-]?exists|duplicate/i;

function isDuplicate(status: number, body: string): boolean {
  if (status === 409) return true;
  return status === 400 && DUPLICATE_HINT.test(body);
}

export default async function BulkAddBookmarks() {
  const clipboardText = await Clipboard.readText();

  if (!clipboardText) {
    await showHUD("Clipboard is empty");
    return;
  }

  const urls = extractUrls(clipboardText);

  if (urls.length === 0) {
    await showHUD("No URLs found in clipboard");
    return;
  }

  const toast = await showToast({
    title: `Adding 0/${urls.length} bookmarks…`,
    style: Toast.Style.Animated,
  });

  let apiUrl: string;
  let apiKey: string;

  try {
    ({ apiUrl, apiKey } = await getApiConfig());
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Bulk add failed";
    toast.message = String(error);
    return;
  }

  let ok = 0;
  let dup = 0;
  let fail = 0;
  let firstFailure: string | undefined;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    toast.title = `Adding ${i + 1}/${urls.length} bookmarks…`;
    toast.message = url;

    try {
      const response = await fetch(new URL("/api/v1/bookmarks", apiUrl).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Raycast Extension",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ type: "link", url, createdAt: new Date().toISOString() }),
      });

      if (response.ok) {
        ok++;
      } else {
        const body = await response.text();

        if (isDuplicate(response.status, body)) {
          dup++;
        } else {
          fail++;
          firstFailure ??= `${response.status}: ${body.slice(0, 120)}`;
        }
      }
    } catch (error) {
      fail++;
      firstFailure ??= String(error);
    }
  }

  const summary = `✅ ${ok} added · ♻️ ${dup} dupes · ❌ ${fail} failed`;

  if (fail > 0 && firstFailure) {
    // Leave the reason on screen instead of burying it in a count.
    toast.style = Toast.Style.Failure;
    toast.title = summary;
    toast.message = firstFailure;
    return;
  }

  toast.hide();
  await showHUD(summary);
}
