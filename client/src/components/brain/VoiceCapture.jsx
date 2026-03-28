import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, MicOff, Square } from 'lucide-react';
import toast from 'react-hot-toast';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export default function VoiceCapture({ onTranscript, disabled }) {
  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const recognitionRef = useRef(null);
  const supported = !!SpeechRecognition;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
    setInterimText('');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const toggle = useCallback(() => {
    if (!supported) {
      toast.error('Speech recognition not supported in this browser');
      return;
    }

    if (listening) {
      stop();
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += text;
        } else {
          interim += text;
        }
      }
      setInterimText(interim);
      if (finalTranscript) {
        onTranscript(finalTranscript);
        finalTranscript = '';
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        toast.error('Microphone access denied');
      } else if (event.error !== 'aborted') {
        toast.error(`Speech error: ${event.error}`);
      }
      setListening(false);
      setInterimText('');
    };

    recognition.onend = () => {
      setListening(false);
      setInterimText('');
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening, supported, stop, onTranscript]);

  if (!supported) return null;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={`px-3 py-3 rounded-lg transition-colors flex items-center gap-1 ${
          listening
            ? 'bg-port-error hover:bg-port-error/80 text-white'
            : 'bg-port-card border border-port-border hover:border-port-accent text-gray-400 hover:text-white'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
        title={listening ? 'Stop recording' : 'Voice capture'}
      >
        {listening ? (
          <>
            <Square className="w-5 h-5" />
            <span className="text-xs animate-pulse">REC</span>
          </>
        ) : (
          <Mic className="w-5 h-5" />
        )}
      </button>
      {interimText && (
        <span className="text-xs text-gray-500 italic max-w-[200px] truncate">
          {interimText}
        </span>
      )}
    </div>
  );
}
