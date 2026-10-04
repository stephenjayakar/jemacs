import type { BufferModel, SaveContext } from "../kernel/buffer"
import type { BackupDirectoryAlist } from "../kernel/backup-path"
import { fileExists } from "../platform/runtime"
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

/** `basic-save-buffer`'s test: the buffer is modified, or its file disappeared since it was visited. */
export async function bufferNeedsSave(buffer: BufferModel): Promise<boolean> {
  return buffer.dirty || (!!buffer.path && !(await fileExists(buffer.path)))
}
