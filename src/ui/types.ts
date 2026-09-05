import type { GapScanner, PacketCodec, SuggestionEngine } from "../domain/types";
import type { Repository } from "../storage/indexeddb-repository";

export interface AppServices {
  repository: Repository;
  suggestions: SuggestionEngine;
  gaps: GapScanner;
  codec: PacketCodec;
}
