import { useCallback } from 'react'
import { connection } from '../lib/transport/connection'
import type { CommandInput } from '../lib/transport/protocol'
import type { CmdAckPayload } from '../types/channels'

/** Send a command to the bridge; resolves with its cmd_ack (null on timeout or
 *  when disconnected). The connection assigns the correlation id. */
export function useSendCommand() {
  return useCallback(
    (command: CommandInput): Promise<CmdAckPayload | null> =>
      connection.sendCommand(command),
    [],
  )
}
