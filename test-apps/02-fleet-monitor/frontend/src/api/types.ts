export interface Vehicle {
  id: string;
  fleetId: string;
  label: string;
  lat: number;
  lng: number;
  speedKph: number;
  lastSeenAt: string;
}

export interface Ping {
  id: string;
  vehicleId: string;
  lat: number;
  lng: number;
  speedKph: number;
  at: string;
}
