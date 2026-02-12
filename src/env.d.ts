declare namespace NodeJS {
  interface ProcessEnv {
    ORIGINAL_URL: string;
    FILENAME: string;
    OGP_DEST_URL: string;
    MAIN_DEST_URL: string;
    PROBE_DEST_URL: string;
    REPORT_URL: string;
  }
}
