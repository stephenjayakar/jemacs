import type { SaveContext } from "../kernel/buffer"
import type { BackupDirectoryAlist } from "../kernel/backup-path"
import { defcustom, getCustom } from "../runtime/custom"

defcustom("backup-directory-alist", "sexp", [] as BackupDirectoryAlist,
  "Alist of filename patterns and backup directories. Each element is `[regexp, directory]`. " +
  "When directory is absolute, backup names use `!` instead of `/`. When directory is null, no backup is made.", "backup")

/** Resolved save options shared by every command-layer save path. */
export function saveContextOptions(): Pick<SaveContext, "makeBackupFiles" | "backupDirectoryAlist"> {
  return {
    makeBackupFiles: getCustom<boolean>("make-backup-files") ?? true,
    backupDirectoryAlist: getCustom<BackupDirectoryAlist>("backup-directory-alist"),
  }
}
