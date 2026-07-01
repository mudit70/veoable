import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import FeedScreen from './src/screens/FeedScreen';
import UploadScreen from './src/screens/UploadScreen';
import PhotoDetailScreen from './src/screens/PhotoDetailScreen';

export type RootStackParamList = {
  Feed: undefined;
  Upload: undefined;
  PhotoDetail: { photoId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Feed">
        <Stack.Screen name="Feed" component={FeedScreen} />
        <Stack.Screen name="Upload" component={UploadScreen} />
        <Stack.Screen name="PhotoDetail" component={PhotoDetailScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
