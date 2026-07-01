import type { Vehicle } from '../api/types';
import VehicleCard from './VehicleCard';

interface Props {
  vehicles: Vehicle[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function VehicleList({ vehicles, selectedId, onSelect }: Props) {
  if (vehicles.length === 0) return <p style={{ padding: 12 }}>No vehicles.</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {vehicles.map((v) => (
        <li key={v.id} onClick={() => onSelect(v.id)}>
          <VehicleCard vehicle={v} selected={v.id === selectedId} />
        </li>
      ))}
    </ul>
  );
}
