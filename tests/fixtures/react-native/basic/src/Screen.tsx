import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';

export default function Screen({ navigation }: any) {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch('/api/data').then(r => r.json()).then(setData);
  }, []);

  const handlePress = () => {
    navigation.navigate('Detail');
  };

  const handleDelete = async () => {
    await fetch('/api/data/1', { method: 'DELETE' });
  };

  return (
    <View>
      <TouchableOpacity onPress={handlePress}>
        <Text>Go to Detail</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={handleDelete}>
        <Text>Delete</Text>
      </TouchableOpacity>
      <TouchableOpacity onLongPress={() => console.log('long')}>
        <Text>Long Press</Text>
      </TouchableOpacity>
    </View>
  );
}
