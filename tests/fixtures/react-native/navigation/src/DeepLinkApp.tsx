// #127 — React Navigation deep-linking config fixture.
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

const Stack = createNativeStackNavigator();

declare const Home: () => null;
declare const Profile: () => null;
declare const Settings: () => null;
declare const About: () => null;

// Linking config — both string-shorthand and object-with-path forms.
const linking = {
  prefixes: ['myapp://', 'https://myapp.com'],
  config: {
    screens: {
      Home: '',
      Profile: 'profile/:id',
      Settings: { path: 'settings' },
      // No deep-link entry for `About` — its routePath should stay null.
    },
  },
};

export function DeepLinkApp() {
  return (
    <NavigationContainer linking={linking}>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={Home} />
        <Stack.Screen name="Profile" component={Profile} />
        <Stack.Screen name="Settings" component={Settings} />
        <Stack.Screen name="About" component={About} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

declare const navigation: { navigate: (screen: string) => void };

// Imperative navigate call to a deep-linked screen — its NAVIGATES_TO
// edge must target the same Screen id the Stack.Screen declaration
// emitted, even though the Stack.Screen now has a routePath while the
// navigate call doesn't know it.
export function goToProfile() {
  navigation.navigate('Profile');
}
