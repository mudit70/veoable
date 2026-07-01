import { useEffect, useState } from 'react';
import type { Vehicle, Ping } from '../api/types';
import { recentPings } from '../api/vehicles';

interface Props {
  vehicles: Vehicle[];
  selectedId: string | null;
}

export default function FleetMap({ vehicles, selectedId }: Props) {
  const [pings, setPings] = useState<Ping[]>([]);

  useEffect(() => {
    if (!selectedId) {
      setPings([]);
      return;
    }
    recentPings(selectedId).then(setPings);
  }, [selectedId]);

  return (
    <div style={{ padding: 16 }}>
      <h2>Map</h2>
      <p>{vehicles.length} vehicles total</p>
      {selectedId ? (
        <ul>
          {pings.map((p) => (
            <li key={p.id}>
              {p.lat.toFixed(4)}, {p.lng.toFixed(4)} @ {p.speedKph.toFixed(0)} kph
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ color: '#999' }}>Select a vehicle to see recent pings.</p>
      )}
    </div>
  );
}
