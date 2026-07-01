import { useEffect, useState } from 'react';
import { listVehicles } from './api/vehicles';
import type { Vehicle } from './api/types';
import VehicleList from './components/VehicleList';
import FleetMap from './components/FleetMap';

export default function App() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    listVehicles().then(setVehicles);
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{ width: 320, borderRight: '1px solid #eee', overflowY: 'auto' }}>
        <h2 style={{ padding: 12 }}>Fleet</h2>
        <VehicleList vehicles={vehicles} onSelect={setSelectedId} selectedId={selectedId} />
      </aside>
      <main style={{ flex: 1 }}>
        <FleetMap vehicles={vehicles} selectedId={selectedId} />
      </main>
    </div>
  );
}
