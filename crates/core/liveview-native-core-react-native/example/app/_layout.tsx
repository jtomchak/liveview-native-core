import React from 'react';
import { Pressable, Text } from 'react-native';
import { Stack } from 'expo-router';
import { ObserveRoot } from 'expo-observe';
import { ChecklistNavigationProvider, useChecklistNavigation } from '../navigation';

function ChecklistStack() {
  const { live, canGoBack } = useChecklistNavigation();
  return <Stack screenOptions={{
    headerStyle: { backgroundColor: '#101a15' }, headerTintColor: '#d8ebae',
    contentStyle: { backgroundColor: '#101a15' }, title: 'Checklists',
    gestureEnabled: false, headerBackVisible: false,
    headerLeft: () => canGoBack ? <Pressable accessibilityLabel="Back" testID="navigation-back" onPress={() => { void live.back().catch(() => {}); }}>
      <Text style={{ color: '#d8ebae', fontSize: 16, padding: 8 }}>‹ Back</Text>
    </Pressable> : null,
  }}>
    <Stack.Screen name="index" options={{ headerShown: false }} />
    <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
    <Stack.Screen name="checklists/index" options={{ title: 'Checklists' }} />
    <Stack.Screen name="checklists/[id]/index" options={{ title: 'Checklist' }} />
    <Stack.Screen name="checklists/[id]/tasks/[taskId]" options={{ title: 'Task' }} />
  </Stack>;
}
function RootLayout() {
  return <ChecklistNavigationProvider><ChecklistStack /></ChecklistNavigationProvider>;
}
export default ObserveRoot.wrap(RootLayout);
