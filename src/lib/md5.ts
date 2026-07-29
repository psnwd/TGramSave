import md5 from "blueimp-md5";

/** Keys the per-chat `_video_list` storage entry off the Telegram tab URL. */
export function hashTabUrl(url: string): string {
  return md5(url);
}

/** Generic short hash, e.g. for deriving a guaranteed-unique catalog id from a media URL. */
export function hashValue(value: string): string {
  return md5(value);
}
