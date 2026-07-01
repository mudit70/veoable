import type { Vehicle } from '../api/types';

interface Props {
  vehicle: Vehicle;
  selected: boolean;
}

export default function VehicleCard({ vehicle, selected }: Props) {
  return (
    <div
      style={{
        padding: 12,
        background: selected ? '#eef' : '#fff',
        borderBottom: '1px solid #eee',
        cursor: 'pointer',
      }}
    >
      <strong>{vehicle.label}</strong>
      <div style={{ fontSize: 12, color: '#666' }}>
        {vehicle.speedKph.toFixed(0)} kph · seen {new Date(vehicle.lastSeenAt).toLocaleTimeString()}
      </div>
    </div>
  );
}
