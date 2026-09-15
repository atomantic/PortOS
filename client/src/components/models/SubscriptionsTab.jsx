import { useEffect, useState } from 'react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import * as api from '../../services/apiProviders';
import BrailleSpinner from '../BrailleSpinner';
import SubscriptionSavingsCard from '../usage/SubscriptionSavingsCard';
import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import Pill from '../ui/Pill';

export default function SubscriptionsTab() {
  const [providers, setProviders] = useState([]);
  const [savings, setSavings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchSubscriptionData = async () => {
      try {
        setLoading(true);
        // Get providers and usage data for subscription savings
        const [providersData, usageData] = await Promise.all([
          api.getProviders(),
          api.getUsage() // This assumes there's an endpoint like /api/usage to get the savings data
        ]);
        
        setProviders(providersData.providers || []);
        setSavings(usageData.subscriptionSavings || null);
        setError(null);
      } catch (err) {
        console.error('Error fetching subscription data:', err);
        setError('Failed to load subscription data');
      } finally {
        setLoading(false);
      }
    };

    fetchSubscriptionData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <BrailleSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-red-500">
        {error}
      </div>
    );
  }

  // For now, just display a placeholder - we're implementing the page structure and navigation
  return (
    <div className="p-4 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white mb-4">AI Subscription Tracking</h2>
        <p className="text-gray-300 mb-4">
          Manage your AI subscriptions, track usage and costs, and view your savings.
          This page shows one subscription per provider family (Claude, Codex, Antigravity, Grok).
        </p>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-4">
        <h3 className="font-medium text-white mb-2">Subscription Tracking</h3>
        <p className="text-sm text-gray-300 mb-3">
          Subscriptions are managed as per-family settings in PortOS.
          Each enabled provider family can track its own quota and subscription cost.
        </p>
        
        <div className="bg-port-bg border border-port-border rounded-lg p-3 mt-3">
          <h4 className="font-medium text-white mb-2">Feature Status</h4>
          <p className="text-sm text-gray-300">
            This page is under active development. Features include:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-300 mt-1 space-y-1">
            <li>Enabling/disabling each subscription family</li>
            <li>Viewing usage statistics and savings</li>
            <li>Updating monthly subscription costs</li>
            <li>Tracking plan tiers (e.g. Claude Max 5x vs 20x)</li>
          </ul>
        </div>
      </div>

      {/* This will be populated with actual data in future work */}
      {savings && (
        <div className="mt-6">
          <h3 className="text-lg font-medium text-white mb-4">Usage and Savings</h3>
          <SubscriptionSavingsCard savings={savings} />
        </div>
      )}
    </div>
  );
}