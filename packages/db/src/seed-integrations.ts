import { SIMULATOR_MAPPING, initialSimulatorState } from '@uc/connector-sdk';
import { DEFAULT_OWNERSHIP } from '@uc/contracts';
import type { Tx } from './client';
import { connections, fieldMappings } from './integrations-schema';

/**
 * Demo connection to the built-in ERP simulator (a test double, labelled DEMO). Nothing is imported until someone
 * pulls and commits from the Integrations screen.
 */
export async function seedDemoSimulatorConnection(tx: Tx, tenantId: string): Promise<void> {
  const [conn] = await tx
    .insert(connections)
    .values({
      tenantId,
      connectorKey: 'simulator',
      name: 'DEMO ERP (simulator)',
      settings: {
        linkExistingBySku: false,
        deletionPolicy: 'flag',
        defaultLocationCode: null,
        defaultProductType: 'standard',
      },
      ownership: DEFAULT_OWNERSHIP,
      adapterState: initialSimulatorState(),
      activeMappingVersion: 1,
    })
    .returning({ id: connections.id });
  await tx.insert(fieldMappings).values({
    tenantId,
    connectionId: conn!.id,
    version: 1,
    rules: SIMULATOR_MAPPING,
    notes: 'Simulator export layout (DEMO)',
  });
}
