import { invoke } from "@/api/transport"
import { terminalConnectionId } from "@/lib/sshTrust"
import { sshConnectionList } from "./ssh"

export async function invokeProjectFile<T>(
  command: "list_project_directory" | "read_file_preview",
  project: string,
  path: string,
): Promise<T> {
  const sshConnectionId = await terminalConnectionId(project, sshConnectionList)
  return invoke<T>(command, { project, path, sshConnectionId })
}
