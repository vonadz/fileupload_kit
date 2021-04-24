<script>
  let fileElement

  const submitFile = async () => {
    const formData = new FormData()
    formData.append('username', 'abc123')
    formData.append('avatar', fileElement.files[0])
    const resp = await fetch('/test_upload.json', {
      method: 'POST',
      //headers: {
      //  'Content-Type': 'application/octet-stream',
      //},
      body: formData//await fileElement.files[0].arrayBuffer()
    })
    console.log(resp)
  }
</script>

<input
  bind:this="{fileElement}"
  id="cover_design"
  name="cover_design"
  type="file"
  accept=".wav, .aiff, .flac, .png"
  required
/>
<button on:click="{submitFile}"> Click </button>
