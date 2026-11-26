Send `Authorization: Bearer $PORTOS_API_TOKEN` on every PortOS API request using the agent's existing environment variable, which is empty when no instance password is set.
A `401 AUTH_REQUIRED` means you should check for a missing, invalid, or expired token before retrying.
