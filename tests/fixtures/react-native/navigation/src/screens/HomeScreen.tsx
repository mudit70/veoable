import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';

export default function HomeScreen({ navigation }: any) {
  const [songs, setSongs] = useState([]);

  useEffect(() => {
    fetch('/api/songs').then(r => r.json()).then(setSongs);
  }, []);

  const goToDetail = () => {
    navigation.navigate('Detail');
  };

  return (
    <View>
      <TouchableOpacity onPress={goToDetail}>
        <Text>Go to Detail</Text>
      </TouchableOpacity>
    </View>
  );
}
