let pipelineInstance: any = null;
let loading: Promise<void> | null = null;

export async function transcribeTelegramVoice(
  blob: Blob,
  onProgress?: (progress: number) => void,
): Promise<string> {
  if (!pipelineInstance) {
    if (!loading) {
      loading = (async () => {
        const { pipeline } = await import("@huggingface/transformers");
        pipelineInstance = await pipeline(
          "automatic-speech-recognition",
          "onnx-community/whisper-tiny",
          {
            dtype: "q8",
            device: "wasm",
            progress_callback: (progress: { status: string; progress?: number }) => {
              if (progress.status === "progress" && progress.progress != null) onProgress?.(progress.progress);
            },
          },
        );
      })().finally(() => {
        loading = null;
      });
    }
    await loading;
  }

  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    const audio = decoded.getChannelData(0);
    const result = await pipelineInstance(audio);
    return (result?.text ?? "").trim();
  } finally {
    await audioContext.close();
  }
}
