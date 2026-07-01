import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';

export default function UserDetailScreen({ route, navigation }: any) {
  const { userId } = route.params;
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    fetch(`https://api.example.com/users/${userId}`)
      .then(res => res.json())
      .then(data => setUser(data));
  }, [userId]);

  const handleDelete = async () => {
    await fetch(`https://api.example.com/users/${userId}`, { method: 'DELETE' });
    Alert.alert('Deleted');
    navigation.goBack();
  };

  return (
    <View>
      <Text>{user?.name}</Text>
      <TouchableOpacity onPress={handleDelete}>
        <Text>Delete User</Text>
      </TouchableOpacity>
      <TouchableOpacity onLongPress={() => navigation.navigate('EditUser', { userId })}>
        <Text>Edit (long press)</Text>
      </TouchableOpacity>
    </View>
  );
}
