import { apiClient } from './client';
import type { Vehicle, Ping } from './types';

export async function listVehicles(): Promise<Vehicle[]> {
  const res = await apiClient.get<Vehicle[]>('/api/vehicles');
  return res.data;
}

export async function getVehicle(id: string): Promise<Vehicle> {
  const res = await apiClient.get<Vehicle>(`/api/vehicles/${id}`);
  return res.data;
}

export async function recentPings(vehicleId: string): Promise<Ping[]> {
  const res = await apiClient.get<Ping[]>(`/api/vehicles/${vehicleId}/pings`);
  return res.data;
}

export async function postPing(vehicleId: string, body: Omit<Ping, 'id' | 'vehicleId'>): Promise<Ping> {
  const res = await apiClient.post<Ping>(`/api/vehicles/${vehicleId}/pings`, body);
  return res.data;
}
