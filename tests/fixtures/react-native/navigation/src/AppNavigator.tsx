import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import HomeScreen from './screens/HomeScreen';
import DetailScreen from './screens/DetailScreen';
import { LoginScreen } from './screens/LoginScreen';
import PlayerScreen from './screens/PlayerScreen';
import HOCWrappedScreen from './screens/HOCWrappedScreen';
import HOCWrappedFunctionScreen from './screens/HOCWrappedFunctionScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function TabNavigator() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="HomeTab" component={HomeScreen} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  return (
    <Stack.Navigator initialRouteName="Login">
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
      <Stack.Screen name="Player" component={PlayerScreen} />
      <Stack.Screen name="HOCWrapped" component={HOCWrappedScreen} />
      <Stack.Screen name="HOCWrappedFn" component={HOCWrappedFunctionScreen} />
    </Stack.Navigator>
  );
}
