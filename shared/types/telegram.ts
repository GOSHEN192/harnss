export interface TelegramStatus {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  botUsername?: string;
  pairingCode: string;
  allowedUserIds: string[];
  assistantInstructions: string;
  allowGroups: false;
}
