import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';

interface User {
  id: string;
  name: string;
}

export default function HomeScreen({ navigation }: any) {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    fetch('https://api.example.com/users')
      .then(res => res.json())
      .then(data => setUsers(data));
  }, []);

  const handleUserPress = (userId: string) => {
    navigation.navigate('UserDetail', { userId });
  };

  return (
    <View>
      <Text>Users</Text>
      <FlatList
        data={users}
        renderItem={({ item }) => (
          <TouchableOpacity onPress={() => handleUserPress(item.id)}>
            <Text>{item.name}</Text>
          </TouchableOpacity>
        )}
      />
      <TouchableOpacity onPress={() => navigation.navigate('CreateUser')}>
        <Text>Create User</Text>
      </TouchableOpacity>
    </View>
  );
}
